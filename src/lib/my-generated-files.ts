// src/lib/my-generated-files.ts
// 내가 대화에서 만든 파일(2026-11-07) — 결과물 화면의 '대화에서 만든 파일'. 양식 채우기(HWPX·DOCX)·표 합치기(XLSX)·앱 결과 내보내기.
// 주인만(`user_id = 요청자` — 관리자도 남의 것은 못 본다, 내려받기 `/api/files/[id]`와 같은 규칙). 대화를 지우면 행도 함께 사라진다.
// 화면에는 저장소 경로를 내보내지 않는다
import { supabaseAdmin } from '@/lib/supabaseAdmin';
import { decodeHistoryCursor, encodeHistoryCursor } from '@/lib/apps/history';
import { fileNamePattern } from '@/lib/file-search';

export const MY_FILES_PAGE = 50;
// 찾기 규칙은 화면과 함께 쓰는 잎 파일에 있다(2026-11-08 — 결과물 화면 통합 찾기)
export { MY_FILES_QUERY_MAX, fileNamePattern, normalizeFileQuery } from '@/lib/file-search';

export type MyGeneratedFile = {
  id: string;
  file_name: string;
  size_bytes: number;
  created_at: string;
  source: string;
  conversation_id: string;
  conversation_title: string | null;
};

type Row = {
  id: string; file_name: string; size_bytes: number | null; created_at: string; template_name: string | null; conversation_id: string;
  conversation?: { title?: string | null } | { title?: string | null }[] | null;
};

/**
 * 쪽 넘기기 기준 — 앞 쪽 마지막 파일의 (만든 시각, id). 앱 실행 기록과 같은 꼴(base64url JSON)이라 시각이 같은 파일도 빠지지 않는다.
 * 꼴이 다르면 null — 라우트가 400으로 거절한다
 */
export const parseCursor = decodeHistoryCursor;

export function toMyFile(row: Row): MyGeneratedFile {
  const conversation = Array.isArray(row.conversation) ? row.conversation[0] : row.conversation;
  return {
    id: row.id,
    file_name: row.file_name,
    size_bytes: Number(row.size_bytes ?? 0),
    created_at: row.created_at,
    source: row.template_name?.trim() || '대화',
    conversation_id: row.conversation_id,
    conversation_title: conversation?.title?.trim() || null,
  };
}

/** 최근 것부터 한 쪽(50개). 한 개 더 읽어 다음 쪽이 있는지 안다. `query`가 있으면 이름에 그 글이 든 파일만(쪽 넘기기도 같은 조건) */
export async function listMyGeneratedFiles(userId: string, cursor: { at: string; id: string } | null, query: string | null = null): Promise<{ files: MyGeneratedFile[]; next: string | null }> {
  let dbQuery = supabaseAdmin
    .from('generated_files')
    .select('id, file_name, size_bytes, created_at, template_name, conversation_id, conversation:conversations(title)')
    .eq('user_id', userId)
    .order('created_at', { ascending: false })
    .order('id', { ascending: false })
    .limit(MY_FILES_PAGE + 1);
  if (query) dbQuery = dbQuery.ilike('file_name', fileNamePattern(query));
  if (cursor) dbQuery = dbQuery.or(`created_at.lt.${cursor.at},and(created_at.eq.${cursor.at},id.lt.${cursor.id})`);
  const { data, error } = await dbQuery;
  if (error) throw new Error(`generated_files: ${error.message}`);
  const rows = (data ?? []) as unknown as Row[];
  const files = rows.slice(0, MY_FILES_PAGE).map(toMyFile);
  const last = files[files.length - 1];
  return { files, next: rows.length > MY_FILES_PAGE && last ? encodeHistoryCursor(last.created_at, last.id) : null };
}
