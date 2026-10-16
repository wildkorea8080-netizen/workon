import { randomUUID } from 'crypto';
import { supabaseAdmin } from '@/lib/supabaseAdmin';
import { SUPABASE_DOCUMENTS_BUCKET } from '@/lib/config';
import { logSystem } from '@/lib/logger';
import type { GeneratedFileRef } from '@/lib/capabilities/types';

/**
 * 비서가 만든 파일 — 기록(generated_files)과 저장소 파일을 함께 다룬다.
 * 저장소 접근은 이 파일에서만 한다(서비스 정의서 7.4 '저장소 연결부').
 *
 * 경로에는 한글 이름을 넣지 않는다. 이름은 DB에만 두고, 내려받을 때 서명
 * 주소의 download 옵션으로 붙인다(templateStoragePath와 같은 관례).
 */

const MAX_TITLE = 80;

/** 확장자는 코드가 정하는 값이지 사용자 입력이 아니다. 경로·이름에 섞이지 않게 막는다 */
function assertExtension(extension: string): void {
  if (!/^[a-z0-9]{1,8}$/.test(extension)) throw new Error('잘못된 확장자');
}

export function safeFileName(title: string, extension: string): string {
  assertExtension(extension);
  const cleaned = title
    .replace(/[\\/:*?"<>|\u0000-\u001f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, MAX_TITLE)
    .trim();
  return `${cleaned || '문서'}.${extension}`;
}

export function generatedStoragePath(orgId: string, conversationId: string, fileId: string, extension: string): string {
  assertExtension(extension);
  return `generated/${orgId}/${conversationId}/${fileId}.${extension}`;
}

export interface SaveGeneratedFileInput {
  organizationId: string;
  departmentId: string;
  userId: string;
  agentId: string;
  conversationId: string;
  templateRef: string;
  templateName: string;
  fileName: string;
  extension: string;
  mimeType: string;
  bytes: Buffer;
}

export async function saveGeneratedFile(input: SaveGeneratedFileInput): Promise<GeneratedFileRef> {
  const id = randomUUID();
  const storagePath = generatedStoragePath(input.organizationId, input.conversationId, id, input.extension);
  const bucket = supabaseAdmin.storage.from(SUPABASE_DOCUMENTS_BUCKET);

  const { error: uploadError } = await bucket.upload(storagePath, input.bytes, {
    contentType: input.mimeType,
    upsert: false,
  });
  if (uploadError) throw new Error(`파일을 저장하지 못했습니다: ${uploadError.message}`);

  // organization_id는 트리거가 department_id로부터 채운다(0029)
  const { error: insertError } = await supabaseAdmin.from('generated_files').insert({
    id,
    conversation_id: input.conversationId,
    user_id: input.userId,
    department_id: input.departmentId,
    agent_id: input.agentId,
    template_ref: input.templateRef,
    template_name: input.templateName,
    file_name: input.fileName,
    mime_type: input.mimeType,
    size_bytes: input.bytes.length,
    storage_path: storagePath,
  });
  if (insertError) {
    // 기록 없는 파일은 아무도 내려받거나 지울 수 없다. 올린 것을 되돌린다.
    // 되돌리기가 실패해도(던지든 오류를 돌려주든) 던지는 것은 원래의 기록 오류다
    try {
      const { error: removeError } = await bucket.remove([storagePath]);
      if (removeError) throw new Error(removeError.message);
    } catch (rollbackError) {
      await logSystem({
        level: 'error',
        category: 'database',
        message: '생성 파일 기록 실패 뒤 저장소 되돌리기도 실패 — 고아 파일을 손으로 지워야 함',
        details: {
          storagePath,
          error: rollbackError instanceof Error ? rollbackError.message : String(rollbackError),
        },
      });
    }
    throw new Error(`파일 기록을 남기지 못했습니다: ${insertError.message}`);
  }

  return { id, file_name: input.fileName, size_bytes: input.bytes.length };
}

export async function findOwnedFile(
  fileId: string,
  userId: string
): Promise<{ storage_path: string; file_name: string } | null> {
  const { data, error } = await supabaseAdmin
    .from('generated_files')
    .select('storage_path, file_name')
    .eq('id', fileId)
    .eq('user_id', userId)
    .maybeSingle();
  if (error) {
    console.error('[generated-files] 조회 오류:', error);
    return null;
  }
  return (data as { storage_path: string; file_name: string } | null) ?? null;
}

/**
 * 60초짜리 서명 주소. 함수가 파일을 직접 보내지 않는 이유: Vercel 서버리스
 * 함수는 응답 본문도 4.5MB로 제한된다(설계 5.3).
 */
export async function signedDownloadUrl(storagePath: string, fileName: string): Promise<string | null> {
  // download 옵션을 SDK에 넘기지 않는다. storage-js는 그 값을 URLSearchParams로 한 번
  // 인코딩한 뒤 URL 전체에 encodeURI를 또 씌워, 한글 이름이 '%25EC…'로 이중 인코딩된다
  // (받은 파일 이름이 퍼센트 코드 그대로가 된다). 직접 한 번만 붙인다.
  const { data, error } = await supabaseAdmin.storage
    .from(SUPABASE_DOCUMENTS_BUCKET)
    .createSignedUrl(storagePath, 60);
  if (error || !data?.signedUrl) {
    console.error('[generated-files] 서명 주소 오류:', error);
    return null;
  }
  const url = data.signedUrl;
  return `${url}${url.includes('?') ? '&' : '?'}download=${encodeURIComponent(fileName)}`;
}

/**
 * 대화를 지우기 전에 부른다. DB 연쇄 삭제는 저장소 파일을 지우지 않는다.
 * 실패해도 던지지 않는다 — 대화 삭제를 막지 않되, 남은 경로를 남겨 손으로 지울 수 있게 한다.
 */
export async function deleteConversationFiles(conversationId: string): Promise<void> {
  try {
    await removeConversationFiles(conversationId);
  } catch (e) {
    // 네트워크 예외 등. 대화 삭제를 막지 않는다
    await logSystem({
      level: 'error',
      category: 'database',
      message: '생성 파일 정리 중 예외 — 대화 삭제 뒤 저장소에 파일이 남을 수 있음',
      details: { conversationId, error: e instanceof Error ? e.message : String(e) },
    });
  }
}

async function removeConversationFiles(conversationId: string): Promise<void> {
  const { data, error } = await supabaseAdmin
    .from('generated_files')
    .select('storage_path')
    .eq('conversation_id', conversationId);
  if (error) {
    await logSystem({
      level: 'error',
      category: 'database',
      message: '생성 파일 목록 조회 실패 — 대화 삭제 뒤 저장소에 파일이 남을 수 있음',
      details: { conversationId, error: error.message },
    });
    return;
  }

  const paths = ((data ?? []) as { storage_path: string }[]).map((r) => r.storage_path);
  const failed = await removeStoragePaths(paths);
  if (failed) {
    await logSystem({
      level: 'error',
      category: 'database',
      message: '생성 파일 저장소 삭제 실패 — 아래 경로를 손으로 지워야 함',
      details: { conversationId, paths: failed.paths, error: failed.error },
    });
  }
}

/** 저장소 remove 한 번에 넘기는 경로 수. Storage API의 한 요청 상한(1000)과 PostgREST 기본 행 상한에 맞춘다 */
const PAGE = 1000;

/**
 * 저장소에서 지운다. 실패한 묶음의 경로와 오류를 돌려준다(전부 지웠으면 null).
 * 한 묶음이 실패해도 나머지 묶음은 지운다.
 */
async function removeStoragePaths(paths: string[]): Promise<{ paths: string[]; error: string } | null> {
  const failedPaths: string[] = [];
  const errors: string[] = [];
  const bucket = supabaseAdmin.storage.from(SUPABASE_DOCUMENTS_BUCKET);
  for (let i = 0; i < paths.length; i += PAGE) {
    const chunk = paths.slice(i, i + PAGE);
    const { error } = await bucket.remove(chunk);
    if (error) {
      failedPaths.push(...chunk);
      errors.push(error.message);
    }
  }
  return failedPaths.length ? { paths: failedPaths, error: errors.join('; ') } : null;
}

/**
 * 사용자 삭제(슈퍼관리자) 때 — DB 행을 지우기 **전에** 그 사용자의 생성 파일 경로를 모은다.
 * generated_files.user_id는 ON DELETE CASCADE라 사용자 행이 지워지면 경로를 알 길이 없다.
 * 사용자가 쓴 모든 대화의 파일이 여기에 든다(파일 주인 = 대화 주인).
 *
 * 저장소는 여기서 지우지 않는다. 사용자 삭제는 다른 외래 키(conversations·usage_logs 등,
 * ON DELETE 없음)에 막혀 실패할 수 있는데, 먼저 지우면 행은 남고 파일만 사라진다.
 * DB 삭제가 성공한 뒤 removeUserFiles로 지운다.
 *
 * 실패해도 던지지 않는다(빈 목록) — 사용자 삭제를 막지 않되 로그를 남긴다.
 * S3의 chat_attachments(chat-uploads/…)가 생기면 그 경로도 여기서 함께 모은다.
 */
export async function listUserFilePaths(userId: string): Promise<string[]> {
  try {
    const paths: string[] = [];
    for (let from = 0; ; from += PAGE) {
      const { data, error } = await supabaseAdmin
        .from('generated_files')
        .select('storage_path')
        .eq('user_id', userId)
        .order('id')
        .range(from, from + PAGE - 1);
      if (error) throw new Error(error.message);
      const rows = (data ?? []) as { storage_path: string }[];
      paths.push(...rows.map((r) => r.storage_path));
      if (rows.length < PAGE) return paths;
    }
  } catch (e) {
    await logSystem({
      level: 'error',
      category: 'database',
      message: '사용자 생성 파일 목록 조회 실패 — 사용자 삭제 뒤 저장소에 파일이 남을 수 있음',
      details: { userId, error: e instanceof Error ? e.message : String(e) },
    });
    return [];
  }
}

/** 사용자 DB 삭제가 성공한 뒤 부른다. 실패해도 던지지 않고 남은 경로를 로그에 남긴다 */
export async function removeUserFiles(userId: string, paths: string[]): Promise<void> {
  let failed: { paths: string[]; error: string } | null;
  try {
    failed = await removeStoragePaths(paths);
  } catch (e) {
    failed = { paths, error: e instanceof Error ? e.message : String(e) };
  }
  if (failed) {
    await logSystem({
      level: 'error',
      category: 'database',
      message: '사용자 삭제 뒤 생성 파일 저장소 삭제 실패 — 아래 경로를 손으로 지워야 함',
      details: { userId, paths: failed.paths, error: failed.error },
    });
  }
}
