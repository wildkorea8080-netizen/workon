// src/lib/my-attachments.ts
// 내가 대화에 올린 파일(2026-11-08) — 결과물 화면의 '대화에 올린 파일'. 대화에 보낸(묶인) 읽힌 첨부만.
// 주인만(`user_id = 요청자` — 관리자도 남의 첨부는 못 본다, 첨부 저장소 규칙과 같음). 대화를 지우면 첨부도 함께 지워진다.
// 화면에는 저장소 경로를 내보내지 않는다. 내려받기는 `/api/attachments/[id]/original`(60초 서명 주소)
import { supabaseAdmin } from '@/lib/supabaseAdmin';
import { encodeHistoryCursor } from '@/lib/apps/history';
import { fileNamePattern } from '@/lib/file-search';
import { MY_FILES_PAGE, toMyFile, type MyGeneratedFile } from '@/lib/my-generated-files';

/** 결과물 화면 한 줄 — 대화에서 만든 파일과 같은 꼴(만든 곳 칸은 '대화에 올림') */
export type MyAttachmentFile = MyGeneratedFile;
export const ATTACHMENT_SOURCE_LABEL = '대화에 올림';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** 최근 것부터 한 쪽(50개). `query`가 있으면 이름에 그 글이 든 첨부만(쪽 넘기기도 같은 조건) */
export async function listMyAttachments(userId: string, cursor: { at: string; id: string } | null, query: string | null = null): Promise<{ files: MyAttachmentFile[]; next: string | null }> {
  let dbQuery = supabaseAdmin
    .from('chat_attachments')
    .select('id, file_name, size_bytes, created_at, conversation_id, conversation:conversations(title)')
    .eq('user_id', userId)
    .eq('status', 'ready')
    .not('conversation_id', 'is', null)
    .order('created_at', { ascending: false })
    .order('id', { ascending: false })
    .limit(MY_FILES_PAGE + 1);
  if (query) dbQuery = dbQuery.ilike('file_name', fileNamePattern(query));
  if (cursor) dbQuery = dbQuery.or(`created_at.lt.${cursor.at},and(created_at.eq.${cursor.at},id.lt.${cursor.id})`);
  const { data, error } = await dbQuery;
  if (error) throw new Error(`chat_attachments: ${error.message}`);
  const rows = (data ?? []) as unknown as Parameters<typeof toMyFile>[0][];
  const files = rows.slice(0, MY_FILES_PAGE).map((r) => ({ ...toMyFile({ ...r, template_name: null }), source: ATTACHMENT_SOURCE_LABEL }));
  const last = files[files.length - 1];
  return { files, next: rows.length > MY_FILES_PAGE && last ? encodeHistoryCursor(last.created_at, last.id) : null };
}

/** 내려받을 원본 — 주인의 것, 대화에 보낸 읽힌 첨부만. 없으면 null, DB 오류면 던진다 */
export async function findMyAttachmentOriginal(userId: string, id: string): Promise<{ storage_path: string; file_name: string } | null> {
  if (!UUID.test(id)) return null;
  const { data, error } = await supabaseAdmin
    .from('chat_attachments')
    .select('storage_path, file_name')
    .eq('id', id.toLowerCase())
    .eq('user_id', userId)
    .eq('status', 'ready')
    .not('conversation_id', 'is', null)
    .maybeSingle();
  if (error) throw new Error(`chat_attachments: ${error.message}`);
  const row = data as { storage_path?: unknown; file_name?: unknown } | null;
  return row && typeof row.storage_path === 'string' && typeof row.file_name === 'string' ? { storage_path: row.storage_path, file_name: row.file_name } : null;
}
