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
  if (paths.length === 0) return;

  const { error: removeError } = await supabaseAdmin.storage.from(SUPABASE_DOCUMENTS_BUCKET).remove(paths);
  if (removeError) {
    await logSystem({
      level: 'error',
      category: 'database',
      message: '생성 파일 저장소 삭제 실패 — 아래 경로를 손으로 지워야 함',
      details: { conversationId, paths, error: removeError.message },
    });
  }
}
