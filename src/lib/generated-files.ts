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

export function safeFileName(title: string, extension: string): string {
  const cleaned = title
    .replace(/[\\/:*?"<>|\u0000-\u001f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, MAX_TITLE)
    .trim();
  return `${cleaned || '문서'}.${extension}`;
}

export function generatedStoragePath(orgId: string, conversationId: string, fileId: string, extension: string): string {
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
    // 기록 없는 파일은 아무도 내려받거나 지울 수 없다. 올린 것을 되돌린다
    await bucket.remove([storagePath]);
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
  const { data, error } = await supabaseAdmin.storage
    .from(SUPABASE_DOCUMENTS_BUCKET)
    .createSignedUrl(storagePath, 60, { download: fileName });
  if (error || !data?.signedUrl) {
    console.error('[generated-files] 서명 주소 오류:', error);
    return null;
  }
  return data.signedUrl;
}

/**
 * 대화를 지우기 전에 부른다. DB 연쇄 삭제는 저장소 파일을 지우지 않는다.
 * 실패해도 던지지 않는다 — 대화 삭제를 막지 않되, 남은 경로를 남겨 손으로 지울 수 있게 한다.
 */
export async function deleteConversationFiles(conversationId: string): Promise<void> {
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
