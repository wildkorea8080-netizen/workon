// src/lib/document-files.ts
import { supabaseAdmin } from '@/lib/supabaseAdmin';
import { SUPABASE_DOCUMENTS_BUCKET } from '@/lib/config';
import type { ActorScope, AgentAccessInfo } from '@/lib/agent-permissions';
import { nodaFilename } from '@/lib/noda';
import { startReadingFields } from '@/lib/document-reading';

/** "다른 비서에도 연결"이 원본에서 읽는 칸. AssignSourceDocument와 함께 고친다. */
export const ASSIGN_SOURCE_COLUMNS =
  'id, department_id, organization_id, visibility, uploaded_by, storage_path, ' +
  'file_name, file_type, title';

export interface AssignSourceDocument {
  id: string;
  department_id: string;
  organization_id: string | null;
  visibility: string | null;
  uploaded_by: string | null;
  storage_path: string | null;
  file_name: string;
  file_type: string | null;
  title: string | null;
}

/**
 * 요청자가 이 문서를 볼 수 있는가. 문서 목록(GET /api/documents)의
 * visibilityFilter와 같은 기준이다 — 목록에 보이는 문서만 다른 비서에 붙인다.
 *
 * 기관을 모르거나 공개 범위를 알 수 없으면 닫는다. 실패가 범위를 넓히면 안 된다.
 */
export function canReadDocument(
  doc: Pick<AssignSourceDocument, 'department_id' | 'organization_id' | 'visibility'>,
  actor: ActorScope
): boolean {
  if (!actor.organizationId || doc.organization_id !== actor.organizationId) return false;
  if (doc.visibility === 'organization') return true;
  if (doc.visibility === 'department') return actor.visibleDepartmentIds.includes(doc.department_id);
  return false;
}

/**
 * 원본 문서를 다른 비서에 붙일 때 새로 넣을 행. 업로드와 같은 공개 규칙:
 * 공식 비서는 원본의 부서·공개 범위를 따르고, 부서·나만의 비서는 그 비서의
 * 부서 안에 둔다(문서 목록과 검색은 비서 단계가 아니라 visibility로 거른다).
 *
 * 읽기는 비서(보관함)마다 따로다 — 새 id·그 id로 만든 NODA 파일 이름·`reading`으로 시작하고,
 * 읽은 내용(summary·metadata·embedding)은 가져오지 않는다. 같은 저장소 파일을 새 보관함에 다시 읽힌다.
 *
 * **모든 행의 키 집합이 같다.** 다르면 PostgREST 배치 insert가 빠진 칸에
 * NULL을 넣는다(CLAUDE.md). organization_id는 트리거(0016)가 채운다.
 */
export function buildAssignedDocumentRow(
  src: AssignSourceDocument,
  target: AgentAccessInfo,
  id: string,
  now: Date
): Record<string, unknown> {
  const official = target.tier === 'official';
  return {
    id,
    department_id: official ? src.department_id : target.department_id,
    visibility: official ? src.visibility : 'department',
    uploaded_by: src.uploaded_by,
    agent_id: target.id,
    storage_path: src.storage_path,
    file_name: src.file_name,
    file_type: src.file_type,
    title: src.title,
    summary: null,
    metadata: {},
    embedding: null,
    noda_filename: nodaFilename(id, src.file_name),
    ...startReadingFields(now),
  };
}

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
