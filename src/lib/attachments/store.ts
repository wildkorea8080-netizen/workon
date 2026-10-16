import { randomUUID } from 'crypto';
import { supabaseAdmin } from '@/lib/supabaseAdmin';
import { SUPABASE_DOCUMENTS_BUCKET } from '@/lib/config';
import { logSystem } from '@/lib/logger';
import { writeUsageLog } from '@/lib/assistant/persist';
import {
  ATTACHMENT_EXTENSIONS,
  CONFIRM_WINDOW_MS,
  MAX_ATTACHMENT_BYTES,
  MAX_ATTACHMENTS_PER_CONVERSATION,
  ORPHAN_TTL_MS,
  attachmentExtension,
  refusedFormatMessage,
} from './limits';
import { AttachmentReadError, readAttachment, summarize } from './reader';
import type { AttachmentExtract, AttachmentRow } from './types';

/**
 * 채팅 첨부 — 기록(chat_attachments)과 저장소 객체를 함께 다룬다.
 * 저장소 접근은 이 파일에서만 한다(generated-files.ts와 같은 원칙).
 *
 * 격리는 전부 여기 조건에 달려 있다(RLS 없음, service role). 모든 조회·변경에
 * `user_id = 요청자`를 건다 — 관리자도 남의 첨부를 보지 못한다(설계 4.2).
 * 경로는 서버가 정하고 기록에 둔다. 확인 단계는 그 기록의 경로만 다룬다.
 */

const TABLE = 'chat_attachments';
/** 화면·도구로 내보내는 칸. 저장소 경로는 싣지 않는다 */
const ROW_COLUMNS = 'id, user_id, conversation_id, file_name, size_bytes, status, summary, error, created_at';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_FILE_NAME = 255;

const MSG_NOT_FOUND = '첨부를 찾을 수 없습니다.';
const MSG_TOO_BIG = `파일이 너무 큽니다. ${Math.round(MAX_ATTACHMENT_BYTES / 1024 / 1024)}MB 이하로 올려 주세요.`;
const MSG_EXPIRED = '업로드 시간이 지났습니다. 다시 올려 주세요.';
const MSG_RETRY = '첨부를 처리하지 못했습니다. 잠시 뒤 다시 올려 주세요.';

/** 확장자는 형식 목록에서 정해진 값이지만, 서버 형식 표에 없는 값이 경로에 섞이지 않게 다시 본다 */
const MIME_BY_EXT: Record<string, string> = {
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  xlsm: 'application/vnd.ms-excel.sheet.macroEnabled.12',
  csv: 'text/csv',
  hwpx: 'application/hwp+zip',
  hwp: 'application/x-hwp',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  pdf: 'application/pdf',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  txt: 'text/plain',
};

type Failure = { ok: false; status: number; message: string };
type StoredPaths = { storage_path: string; extract_path: string | null };

function bucket() {
  return supabaseAdmin.storage.from(SUPABASE_DOCUMENTS_BUCKET);
}

function assertSegment(value: string): void {
  // id·기관·사용자는 uuid지만, '/'·'..'가 섞여 다른 사람 자리를 가리키지 못하게 막는다
  if (!/^[A-Za-z0-9-]{1,64}$/.test(value)) throw new Error('잘못된 경로 조각');
}

export function attachmentPaths(
  orgId: string,
  userId: string,
  id: string,
  ext: string
): { storage: string; extract: string } {
  if (!/^[a-z0-9]{1,8}$/.test(ext)) throw new Error('잘못된 확장자');
  for (const s of [orgId, userId, id]) assertSegment(s);
  const base = `chat-uploads/${orgId}/${userId}/${id}`;
  return { storage: `${base}.${ext}`, extract: `${base}.json` };
}

/** 깨진 시각은 만료로 본다 — 모르면 거부하는 쪽으로 닫는다 */
export function isConfirmExpired(createdAt: string, now: number): boolean {
  const t = Date.parse(createdAt);
  if (Number.isNaN(t)) return true;
  return now - t > CONFIRM_WINDOW_MS;
}

/** 실패해도 던지지 않는다. 남은 경로를 남겨 손으로 지울 수 있게 한다 */
async function removeObjects(paths: string[], context: Record<string, unknown>, what: string): Promise<boolean> {
  if (paths.length === 0) return true;
  try {
    const { error } = await bucket().remove(paths);
    if (error) throw new Error(error.message);
    return true;
  } catch (e) {
    await logSystem({
      level: 'error',
      category: 'database',
      message: `${what} — 아래 경로를 손으로 지워야 함`,
      details: { ...context, paths, error: e instanceof Error ? e.message : String(e) },
    });
    return false;
  }
}

function pathsOf(rows: StoredPaths[]): string[] {
  return rows.flatMap((r) => [r.storage_path, r.extract_path]).filter((p): p is string => Boolean(p));
}

// ── 발급 ─────────────────────────────────────────────────────

export async function createUpload(
  actor: { userId: string; departmentId: string; organizationId: string },
  input: { fileName: string; size: number }
): Promise<{ ok: true; id: string; path: string; token: string } | Failure> {
  const fileName = typeof input.fileName === 'string' ? input.fileName.trim() : '';
  if (!fileName || fileName.length > MAX_FILE_NAME || /[\u0000-\u001f]/.test(fileName)) {
    return { ok: false, status: 400, message: '파일 이름이 올바르지 않습니다.' };
  }
  const refused = refusedFormatMessage(fileName);
  if (refused) return { ok: false, status: 400, message: refused };
  const ext = attachmentExtension(fileName);
  if (!ext || !MIME_BY_EXT[ext]) {
    const list = ATTACHMENT_EXTENSIONS.map((e) => e.slice(1).toUpperCase()).join(', ');
    return { ok: false, status: 400, message: `첨부할 수 없는 형식입니다. ${list} 파일만 올릴 수 있습니다.` };
  }
  const size = input.size;
  if (size === 0) return { ok: false, status: 400, message: '빈 파일은 첨부할 수 없습니다.' };
  if (typeof size !== 'number' || !Number.isInteger(size) || size < 0) {
    return { ok: false, status: 400, message: '파일 크기가 올바르지 않습니다.' };
  }
  // 신고 크기는 믿지 않는다 — 확인 때 실제 크기를 다시 본다. 여기서는 먼저 걸러 줄 뿐
  if (size > MAX_ATTACHMENT_BYTES) return { ok: false, status: 413, message: MSG_TOO_BIG };

  // 별도 예약 작업 없이, 올릴 때마다 그 사용자의 묵은 첨부를 치운다(설계 4.7)
  await purgeOrphans(actor.userId, Date.now());

  const id = randomUUID();
  const { storage } = attachmentPaths(actor.organizationId, actor.userId, id, ext);

  // 행을 먼저 넣는다 — 서명 주소가 나간 객체는 언제나 기록이 있어 정리 대상이 된다
  // organization_id는 트리거가 department_id로부터 채운다(0030)
  const { error: insertError } = await supabaseAdmin.from(TABLE).insert({
    id,
    user_id: actor.userId,
    department_id: actor.departmentId,
    file_name: fileName,
    mime_type: MIME_BY_EXT[ext],
    size_bytes: size,
    storage_path: storage,
    status: 'pending',
  });
  if (insertError) {
    console.error('[attachments] 기록 실패:', insertError.message);
    return { ok: false, status: 500, message: MSG_RETRY };
  }

  const { data, error } = await bucket().createSignedUploadUrl(storage);
  if (error || !data?.token) {
    console.error('[attachments] 업로드 주소 발급 실패:', error?.message);
    // 주소가 없으면 아무도 올릴 수 없다. 남은 행은 쓸모가 없다
    await supabaseAdmin.from(TABLE).delete().eq('id', id).eq('user_id', actor.userId);
    return { ok: false, status: 500, message: MSG_RETRY };
  }

  return { ok: true, id, path: storage, token: data.token };
}

// ── 확인 ─────────────────────────────────────────────────────

/** 확인 전 거부(시간·크기): 객체와 행을 함께 지운다. 조건에 pending을 걸어 확인을 끝낸 행은 건드리지 않는다 */
async function discardPending(userId: string, id: string, storagePath: string, why: string): Promise<void> {
  await removeObjects([storagePath], { attachmentId: id }, `첨부 ${why} 거부 뒤 저장소 삭제 실패`);
  await supabaseAdmin.from(TABLE).delete().eq('id', id).eq('user_id', userId).eq('status', 'pending');
}

/** 저장소 경로를 떼고 내보낸다 */
function toRow(r: AttachmentRow): AttachmentRow {
  return {
    id: r.id,
    user_id: r.user_id,
    conversation_id: r.conversation_id,
    file_name: r.file_name,
    size_bytes: r.size_bytes,
    status: r.status,
    summary: r.summary,
    error: r.error,
    created_at: r.created_at,
  };
}

async function fetchOwnRow(userId: string, id: string): Promise<AttachmentRow | null> {
  const { data } = await supabaseAdmin
    .from(TABLE)
    .select(ROW_COLUMNS)
    .eq('id', id)
    .eq('user_id', userId)
    .maybeSingle();
  return data ? toRow(data as AttachmentRow) : null;
}

async function storedSize(path: string): Promise<number | null> {
  try {
    const { data, error } = await bucket().info(path);
    if (error || !data) return null;
    const size = (data as { size?: unknown }).size;
    return typeof size === 'number' ? size : null;
  } catch {
    // 정보가 없으면 내려받은 길이로 판정한다
    return null;
  }
}

export async function confirmUpload(
  actor: { userId: string; departmentId: string; organizationId: string },
  id: string
): Promise<{ ok: true; attachment: AttachmentRow } | Failure> {
  if (typeof id !== 'string' || !UUID.test(id)) return { ok: false, status: 404, message: MSG_NOT_FOUND };

  const { data: found, error: findError } = await supabaseAdmin
    .from(TABLE)
    .select(`${ROW_COLUMNS}, storage_path`)
    .eq('id', id)
    .eq('user_id', actor.userId)
    .maybeSingle();
  if (findError) {
    console.error('[attachments] 조회 실패:', findError.message);
    return { ok: false, status: 500, message: MSG_RETRY };
  }
  const row = found as (AttachmentRow & { storage_path: string }) | null;
  if (!row) return { ok: false, status: 404, message: MSG_NOT_FOUND };

  // 다시 보낸 확인(새로고침·재시도)은 읽기·기록을 되풀이하지 않고 결과만 돌려준다
  if (row.status !== 'pending') return { ok: true, attachment: toRow(row) };

  // 서명 업로드 주소는 2시간 고정이라, 확인을 짧게 받아 오래된 주소로 올린 것을 끊는다(설계 4.1)
  if (isConfirmExpired(row.created_at, Date.now())) {
    await discardPending(actor.userId, id, row.storage_path, '시간 초과');
    return { ok: false, status: 410, message: MSG_EXPIRED };
  }

  const ext = attachmentExtension(row.file_name);
  if (!ext) return { ok: false, status: 400, message: '첨부할 수 없는 형식입니다.' };

  // 서명 주소는 크기를 강제하지 않는다. 내려받기 전에 저장소가 아는 크기로 먼저 거른다
  const known = await storedSize(row.storage_path);
  if (known !== null && known > MAX_ATTACHMENT_BYTES) {
    await discardPending(actor.userId, id, row.storage_path, '크기 초과');
    return { ok: false, status: 413, message: MSG_TOO_BIG };
  }

  const { data: blob, error: downloadError } = await bucket().download(row.storage_path);
  if (downloadError || !blob) {
    // 아직 올라가지 않았을 수 있다. pending으로 두면 24시간 뒤 정리된다
    return { ok: false, status: 400, message: '올린 파일을 찾지 못했습니다. 다시 올려 주세요.' };
  }

  let uploadedExtract: string | null = null;
  try {
    const bytes = Buffer.from(await blob.arrayBuffer());
    if (bytes.length > MAX_ATTACHMENT_BYTES) {
      await discardPending(actor.userId, id, row.storage_path, '크기 초과');
      return { ok: false, status: 413, message: MSG_TOO_BIG };
    }

    let patch: Record<string, unknown>;
    let tables = 0;
    let status: 'ready' | 'failed';
    try {
      const extract = await readAttachment(bytes, row.file_name);
      const { extract: extractPath } = attachmentPaths(actor.organizationId, actor.userId, id, ext);
      const { error: uploadError } = await bucket().upload(
        extractPath,
        Buffer.from(JSON.stringify(extract), 'utf8'),
        // 같은 확인이 겹쳐 들어와도 같은 내용이다
        { contentType: 'application/json', upsert: true }
      );
      if (uploadError) throw new Error(`읽은 내용 저장 실패: ${uploadError.message}`);
      uploadedExtract = extractPath;
      tables = extract.tables.length;
      status = 'ready';
      patch = { status, summary: summarize(extract), extract_path: extractPath, error: null, size_bytes: bytes.length };
    } catch (e) {
      if (!(e instanceof AttachmentReadError)) throw e;
      status = 'failed';
      patch = { status, summary: null, extract_path: null, error: e.message, size_bytes: bytes.length };
    }

    const { data: updated, error: updateError } = await supabaseAdmin
      .from(TABLE)
      .update(patch)
      .eq('id', id)
      .eq('user_id', actor.userId)
      .eq('status', 'pending')
      .select(ROW_COLUMNS);
    if (updateError) throw new Error(`첨부 상태 기록 실패: ${updateError.message}`);

    const first = ((updated ?? []) as AttachmentRow[])[0];
    const attachment = first ? toRow(first) : await fetchOwnRow(actor.userId, id);
    if (!attachment) return { ok: false, status: 404, message: MSG_NOT_FOUND };
    // 겹친 확인이 먼저 끝냈으면 그쪽이 기록을 남겼다
    if (!updated || (updated as unknown[]).length === 0) return { ok: true, attachment };

    if (status === 'failed') {
      // 읽지 못한 원본은 쓸 데가 없다. 보관하지 않는다
      await removeObjects([row.storage_path], { attachmentId: id }, '읽기 실패한 첨부 원본 삭제 실패');
    }

    // 파일 이름은 남기지 않는다 — 감사 CSV가 기관 밖으로 나갈 수 있다(설계 4.8)
    await writeUsageLog({
      departmentId: actor.departmentId,
      userId: actor.userId,
      action: 'file_attached',
      resourceType: 'chat_attachment',
      resourceId: id,
      details: { format: ext, size_bytes: bytes.length, tables, status },
    });

    return { ok: true, attachment };
  } catch (e) {
    // 메모리·시간 초과 등. ready를 남기지 않는다 — pending은 24시간 뒤 정리된다
    console.error('[attachments] 확인 중 예외:', e instanceof Error ? e.message : e);
    // 기록에 오르지 못한 읽은 내용은 정리 대상이 아니다(extract_path NULL). 여기서 치운다
    if (uploadedExtract) await removeObjects([uploadedExtract], { attachmentId: id }, '기록 실패 뒤 읽은 내용 삭제 실패');
    return { ok: false, status: 500, message: '파일을 처리하는 중 문제가 생겼습니다. 잠시 뒤 다시 올려 주세요.' };
  }
}

// ── 대화와 묶기·조회 ─────────────────────────────────────────

async function ownsConversation(userId: string, conversationId: string): Promise<boolean> {
  if (!UUID.test(conversationId)) return false;
  const { data, error } = await supabaseAdmin
    .from('conversations')
    .select('id')
    .eq('id', conversationId)
    .eq('user_id', userId)
    .maybeSingle();
  return !error && Boolean(data);
}

/** 대화 주인 확인. 라우트가 남의 대화 id로 목록을 묻는 것을 404로 돌린다 */
export async function isConversationOwner(userId: string, conversationId: string): Promise<boolean> {
  return ownsConversation(userId, conversationId);
}

export async function listConversationAttachments(userId: string, conversationId: string): Promise<AttachmentRow[]> {
  const { data, error } = await supabaseAdmin
    .from(TABLE)
    .select(ROW_COLUMNS)
    .eq('user_id', userId)
    .eq('conversation_id', conversationId)
    .eq('status', 'ready')
    .order('created_at', { ascending: true });
  if (error) {
    console.error('[attachments] 목록 조회 실패:', error.message);
    return [];
  }
  return ((data ?? []) as AttachmentRow[]).map(toRow);
}

const MSG_BIND_REFUSED = '쓸 수 없는 첨부가 있습니다. 첨부를 지우고 다시 올려 주세요.';

/**
 * 채팅 요청의 첨부를 이 대화로 묶는다. 하나라도 어긋나면 아무것도 묶지 않는다.
 * 다른 사람 것·다른 대화 것·읽지 못한 것을 끌어오지 못하게 하는 경계다(설계 4.2).
 */
export async function bindAttachments(
  userId: string,
  conversationId: string,
  ids: string[]
): Promise<{ ok: true; rows: AttachmentRow[] } | { ok: false; message: string }> {
  const unique = [...new Set(ids)];
  if (unique.length === 0) return { ok: true, rows: [] };
  if (!unique.every((id) => typeof id === 'string' && UUID.test(id))) return { ok: false, message: MSG_BIND_REFUSED };
  if (!(await ownsConversation(userId, conversationId))) return { ok: false, message: MSG_BIND_REFUSED };

  const { data, error } = await supabaseAdmin
    .from(TABLE)
    .select(ROW_COLUMNS)
    .in('id', unique)
    .eq('user_id', userId);
  if (error) return { ok: false, message: MSG_RETRY };
  const rows = ((data ?? []) as AttachmentRow[]).map(toRow);

  const usable = rows.filter(
    (r) => r.status === 'ready' && (r.conversation_id === null || r.conversation_id === conversationId)
  );
  if (usable.length !== unique.length) return { ok: false, message: MSG_BIND_REFUSED };

  const toBind = usable.filter((r) => r.conversation_id === null).map((r) => r.id);
  if (toBind.length === 0) return { ok: true, rows: usable };

  const { count, error: countError } = await supabaseAdmin
    .from(TABLE)
    .select('id', { count: 'exact', head: true })
    .eq('conversation_id', conversationId);
  if (countError) return { ok: false, message: MSG_RETRY };
  if ((count ?? 0) + toBind.length > MAX_ATTACHMENTS_PER_CONVERSATION) {
    return { ok: false, message: `한 대화에 첨부는 ${MAX_ATTACHMENTS_PER_CONVERSATION}개까지입니다.` };
  }

  // 조건을 다시 건다 — 그 사이 다른 대화에 묶였으면 여기서 빠지고 개수로 드러난다
  const { data: bound, error: bindError } = await supabaseAdmin
    .from(TABLE)
    .update({ conversation_id: conversationId })
    .in('id', toBind)
    .eq('user_id', userId)
    .eq('status', 'ready')
    .is('conversation_id', null)
    .select(ROW_COLUMNS);
  if (bindError) return { ok: false, message: MSG_RETRY };
  if (((bound ?? []) as unknown[]).length !== toBind.length) {
    // 일부만 묶였다. 이번 요청은 거부하되 묶인 것은 이 사용자의 이 대화이므로 되돌리지 않는다
    return { ok: false, message: MSG_BIND_REFUSED };
  }

  return { ok: true, rows: usable.map((r) => ({ ...r, conversation_id: conversationId })) };
}

/** 읽은 내용. 경로는 기록이 아니라 주인·id로 다시 계산한다 — 남의 자리를 가리킬 수 없다 */
export async function loadExtract(row: { id: string; user_id: string }, orgId: string): Promise<AttachmentExtract | null> {
  try {
    const { extract } = attachmentPaths(orgId, row.user_id, row.id, 'json');
    const { data, error } = await bucket().download(extract);
    if (error || !data) return null;
    return JSON.parse(await data.text()) as AttachmentExtract;
  } catch (e) {
    console.error('[attachments] 읽은 내용 불러오기 실패:', e instanceof Error ? e.message : e);
    return null;
  }
}

// ── 지우기·정리 ─────────────────────────────────────────────

/** 보내기 전 첨부만. 대화에 묶인 것은 대화와 함께 산다(설계 4.7) */
export async function deleteAttachment(userId: string, id: string): Promise<boolean> {
  if (typeof id !== 'string' || !UUID.test(id)) return false;
  // 행부터 지우며 경로를 받는다 — 조건을 통과한 것의 객체만 지운다
  const { data, error } = await supabaseAdmin
    .from(TABLE)
    .delete()
    .eq('id', id)
    .eq('user_id', userId)
    .is('conversation_id', null)
    .select('storage_path, extract_path');
  if (error) {
    console.error('[attachments] 삭제 실패:', error.message);
    return false;
  }
  const rows = (data ?? []) as StoredPaths[];
  if (rows.length === 0) return false;
  await removeObjects(pathsOf(rows), { attachmentId: id }, '첨부 저장소 삭제 실패');
  return true;
}

/**
 * 대화를 지우기 전에 부른다. DB 연쇄 삭제는 저장소 객체를 지우지 않는다.
 * 실패해도 던지지 않는다 — 대화 삭제를 막지 않되 남은 경로를 남긴다(deleteConversationFiles와 같은 모양).
 */
export async function deleteConversationAttachments(conversationId: string): Promise<void> {
  try {
    const { data, error } = await supabaseAdmin
      .from(TABLE)
      .select('storage_path, extract_path')
      .eq('conversation_id', conversationId);
    if (error) {
      await logSystem({
        level: 'error',
        category: 'database',
        message: '첨부 목록 조회 실패 — 대화 삭제 뒤 저장소에 첨부가 남을 수 있음',
        details: { conversationId, error: error.message },
      });
      return;
    }
    await removeObjects(pathsOf((data ?? []) as StoredPaths[]), { conversationId }, '대화 첨부 저장소 삭제 실패');
  } catch (e) {
    await logSystem({
      level: 'error',
      category: 'database',
      message: '첨부 정리 중 예외 — 대화 삭제 뒤 저장소에 첨부가 남을 수 있음',
      details: { conversationId, error: e instanceof Error ? e.message : String(e) },
    });
  }
}

/**
 * 대화에 묶이지 못한 채 24시간 지난 첨부(안 보냄·pending)를 치운다. 실패해도 던지지 않는다 —
 * 정리 때문에 새 업로드가 막히면 안 된다. 행을 조건부로 먼저 지워, 그 사이 묶인 첨부의 객체는 건드리지 않는다.
 */
export async function purgeOrphans(userId: string, now: number): Promise<void> {
  try {
    const cutoff = new Date(now - ORPHAN_TTL_MS).toISOString();
    const { data, error } = await supabaseAdmin
      .from(TABLE)
      .delete()
      .eq('user_id', userId)
      .is('conversation_id', null)
      .lt('created_at', cutoff)
      .select('storage_path, extract_path');
    if (error) throw new Error(error.message);
    await removeObjects(pathsOf((data ?? []) as StoredPaths[]), { userId }, '묵은 첨부 저장소 삭제 실패');
  } catch (e) {
    await logSystem({
      level: 'error',
      category: 'database',
      message: '묵은 첨부 정리 실패',
      details: { userId, error: e instanceof Error ? e.message : String(e) },
    });
  }
}
