// src/lib/document-files.ts
import { supabaseAdmin } from '@/lib/supabaseAdmin';
import { SUPABASE_DOCUMENTS_BUCKET } from '@/lib/config';

/**
 * 문서의 저장소 파일을 아무 행도 쓰지 않을 때만 지운다.
 *
 * 여러 비서에 한 번에 올린 문서는 비서마다 행이 하나씩이지만 저장소 파일은
 * 하나를 함께 쓴다(업로드 라우트). 행 하나를 지울 때 파일까지 지우면 남은
 * 비서의 문서가 원본을 잃는다.
 *
 * 세는 데 실패하면 지우지 않는다. 남은 파일은 저장 공간만 쓰지만, 잘못
 * 지운 파일은 되돌릴 수 없다. 호출 전에 행을 먼저 지워 둬야 한다.
 */
export async function removeStorageFileIfUnused(storagePath: string): Promise<void> {
  const { count, error } = await supabaseAdmin
    .from('documents')
    .select('id', { count: 'exact', head: true })
    .eq('storage_path', storagePath);

  if (error || count === null) {
    console.error('[document-files] 남은 행을 세지 못해 파일을 지우지 않음', storagePath, error?.message);
    return;
  }
  if (count > 0) return;

  const { error: removeError } = await supabaseAdmin.storage.from(SUPABASE_DOCUMENTS_BUCKET).remove([storagePath]);
  if (removeError) console.error('[document-files] 파일 지우기 실패', storagePath, removeError.message);
}
