// src/lib/attachments/reuse.ts
// 지난 파일을 대화에 다시 붙이기(2026-11-05) — 다른 대화에서 내가 붙였던 첨부, 비서가 나에게 만들어 준 파일을
// 새 첨부로 **복사**해 붙인다. 원본 기록과 따로 산다(옛 대화를 지워도 새 첨부는 남고, 새 대화를 지우면 새 첨부만 지워진다).
//
// 길은 직접 올리기와 같다: 발급(createUpload — 보내지 않은 첨부 상한·정리·경로) → 서버가 바이트를 그 경로에 올림 →
// 확인(confirmUpload — 크기·읽기·사용 기록). 그래서 형식·크기·읽기·스캔 PDF·묘비 규칙이 따로 갈라지지 않는다.
// 격리: 원본은 **요청자의 것**만(`user_id = 요청자`) — 관리자도 남의 첨부·만든 파일을 가져오지 못한다.
import { supabaseAdmin } from '@/lib/supabaseAdmin';
import { SUPABASE_DOCUMENTS_BUCKET } from '@/lib/config';
import { attachmentExtension, MAX_ATTACHMENT_BYTES } from './limits';
import { confirmUpload, createUpload, deleteAttachment } from './store';
import type { AttachmentRow } from './types';
import type { ReusableFile, ReuseKind } from './reuse-types';
export type { ReusableFile, ReuseKind } from './reuse-types';

export const REUSE_WINDOW_DAYS = 90;
export const REUSE_LIST_MAX = 20;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;


type Failure = { ok: false; status: number; message: string };
type Actor = { userId: string; departmentId: string; organizationId: string };

const MSG_NOT_FOUND = '다시 붙일 파일을 찾을 수 없습니다.';
const MSG_RETRY = '파일을 다시 붙이지 못했습니다. 잠시 뒤 다시 시도해 주세요.';

/**
 * 다시 붙일 수 있는 파일 목록(순수) — 첨부할 수 있는 형식·크기 상한 안만, 같은 이름·같은 크기는 새것 하나만, 새것부터 20개.
 * 화면은 이 목록에서만 고르지만, 가져오기는 서버가 원본을 다시 찾아 본다
 */
export function reusableList(rows: ReusableFile[]): ReusableFile[] {
  const seen = new Set<string>();
  return rows
    .filter((r) => attachmentExtension(r.file_name) !== null && r.size_bytes > 0 && r.size_bytes <= MAX_ATTACHMENT_BYTES)
    .sort((a, b) => (a.created_at < b.created_at ? 1 : a.created_at > b.created_at ? -1 : 0))
    .filter((r) => {
      const key = `${r.file_name}\u0000${r.size_bytes}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .slice(0, REUSE_LIST_MAX);
}

/** 최근 90일 안의 내 첨부(대화에 보낸 것·읽힌 것)와 비서가 나에게 만들어 준 파일 */
export async function listReusableFiles(userId: string, now = Date.now()): Promise<ReusableFile[]> {
  const since = new Date(now - REUSE_WINDOW_DAYS * 24 * 60 * 60 * 1000).toISOString();
  const [attachments, generated] = await Promise.all([
    supabaseAdmin
      .from('chat_attachments')
      .select('id, file_name, size_bytes, created_at')
      .eq('user_id', userId)
      .eq('status', 'ready')
      .not('conversation_id', 'is', null)
      .gte('created_at', since)
      .order('created_at', { ascending: false })
      .limit(60),
    supabaseAdmin
      .from('generated_files')
      .select('id, file_name, size_bytes, created_at')
      .eq('user_id', userId)
      .gte('created_at', since)
      .order('created_at', { ascending: false })
      .limit(60),
  ]);
  if (attachments.error || generated.error) throw new Error(`reusable files: ${(attachments.error ?? generated.error)!.message}`);
  const as = (kind: ReuseKind) => (r: { id: string; file_name: string; size_bytes: number | null; created_at: string }): ReusableFile => ({ kind, id: r.id, file_name: r.file_name, size_bytes: Number(r.size_bytes ?? 0), created_at: r.created_at });
  return reusableList([
    ...((attachments.data ?? []) as { id: string; file_name: string; size_bytes: number | null; created_at: string }[]).map(as('attachment')),
    ...((generated.data ?? []) as { id: string; file_name: string; size_bytes: number | null; created_at: string }[]).map(as('generated')),
  ]);
}

/** 원본 — 요청자의 것만. 첨부는 읽힌(`ready`) 것만(읽지 못한 것은 원본을 지웠다) */
async function findSource(userId: string, kind: ReuseKind, id: string): Promise<{ storage_path: string; file_name: string } | null | 'error'> {
  const query = kind === 'attachment'
    ? supabaseAdmin.from('chat_attachments').select('storage_path, file_name, status').eq('id', id).eq('user_id', userId).eq('status', 'ready')
    : supabaseAdmin.from('generated_files').select('storage_path, file_name').eq('id', id).eq('user_id', userId);
  const { data, error } = await query.maybeSingle();
  if (error) return 'error';
  const row = data as { storage_path?: unknown; file_name?: unknown } | null;
  return row && typeof row.storage_path === 'string' && typeof row.file_name === 'string' ? { storage_path: row.storage_path, file_name: row.file_name } : null;
}

/**
 * 지난 파일 하나를 새 첨부로 붙인다. 성공하면 새 첨부(읽은 상태 — 읽지 못했으면 `failed`와 이유)를 돌려준다.
 * 새 첨부는 직접 올린 것과 똑같이 보낼 때 대화에 묶이고, 보내지 않으면 24시간 뒤 정리된다
 */
export async function reuseFile(actor: Actor, kind: unknown, id: unknown): Promise<{ ok: true; attachment: AttachmentRow } | Failure> {
  if ((kind !== 'attachment' && kind !== 'generated') || typeof id !== 'string' || !UUID.test(id)) return { ok: false, status: 404, message: MSG_NOT_FOUND };
  const source = await findSource(actor.userId, kind, id.toLowerCase());
  if (source === 'error') return { ok: false, status: 503, message: MSG_RETRY };
  if (!source) return { ok: false, status: 404, message: MSG_NOT_FOUND };
  return attachStoredObject(actor, source);
}

/**
 * 저장소에 있는 파일 하나를 새 첨부로 올린다 — 지난 파일 다시 붙이기와 앱 예약의 올린 파일(0073)이 함께 쓴다.
 * 발급(형식·크기·보내지 않은 첨부 상한) → 서버가 바이트를 올림 → 확인(읽기·사용 기록). 원본을 못 받으면 404
 */
export async function attachStoredObject(actor: Actor, source: { storage_path: string; file_name: string }): Promise<{ ok: true; attachment: AttachmentRow } | Failure> {
  const bucket = supabaseAdmin.storage.from(SUPABASE_DOCUMENTS_BUCKET);
  const { data: blob, error: downloadError } = await bucket.download(source.storage_path);
  if (downloadError || !blob) return { ok: false, status: 404, message: '원본 파일이 더 남아 있지 않습니다.' };
  return attachBytes(actor, source.file_name, Buffer.from(await blob.arrayBuffer()), blob.type);
}

/**
 * 서버가 가진 바이트를 새 첨부로 올린다 — 위의 저장소 복사와 외부 연동이 보낸 파일(2026-11-08)이 함께 쓴다.
 * 직접 올리기와 같은 발급(형식·크기·보내지 않은 첨부 상한) → 올림 → 확인(읽기·사용 기록)
 */
export async function attachBytes(actor: Actor, fileName: string, bytes: Buffer, contentType?: string): Promise<{ ok: true; attachment: AttachmentRow } | Failure> {
  const bucket = supabaseAdmin.storage.from(SUPABASE_DOCUMENTS_BUCKET);
  // 발급 — 형식·크기(실제 바이트 길이로)·보내지 않은 첨부 상한을 직접 올리기와 같은 규칙으로 본다
  const issued = await createUpload(actor, { fileName, size: bytes.length });
  if (!issued.ok) return issued;

  const { error: uploadError } = await bucket.upload(issued.path, bytes, { contentType: contentType || 'application/octet-stream', upsert: false });
  if (uploadError) {
    // 묘비로 남긴다(지운 첨부와 같은 꼴) — 객체가 기록 없이 남지 않게
    await deleteAttachment(actor.userId, issued.id);
    return { ok: false, status: 500, message: MSG_RETRY };
  }
  return confirmUpload(actor, issued.id);
}
