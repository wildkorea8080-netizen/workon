// src/lib/common-edition-compare.ts
// 공통 자료실(S5) 문서의 새 판과 그 판이 바꾼 옛 판을 맞댄다(GET /api/super/common-documents/[id]/compare).
// 슈퍼관리자만 부른다(라우트가 확인). 원본 읽기·대조는 비서 문서와 같은 compareEditionFiles.

import { compareEditionFiles, type CompareDeps, type CompareOutcome, type EditionSide } from '@/lib/document-edition-compare';

export const COMMON_COMPARE_COLUMNS =
  'id, org_type, title, edition_year, file_name, storage_path, replaces_id, noda_status, retired_at, created_at';

export interface CommonCompareRow {
  id: string;
  org_type: string;
  title: string;
  edition_year: number;
  file_name: string;
  storage_path: string | null;
  replaces_id: string | null;
  noda_status: string | null;
  retired_at: string | null;
  created_at: string | null;
}

export interface CommonCompareDeps extends Pick<CompareDeps, 'download' | 'read'> {
  /** 한 행. 없으면 null, 조회 실패는 던진다 */
  loadRow(id: string): Promise<CommonCompareRow | null>;
}

/** 공통 문서는 시행일 칸이 없다 — 이름에 기준 연도를 붙여 어느 해 판인지 보인다 */
export function commonSide(row: CommonCompareRow): EditionSide {
  return {
    id: row.id,
    name: `${row.title}(${row.edition_year})`,
    effective_from: null,
    status: row.retired_at ? 'retired' : row.noda_status,
    created_at: row.created_at,
  };
}

const fail = (status: number, message: string): CompareOutcome => ({ ok: false, status, message });

/** 같은 기관 유형의 두 판만 맞댄다(판 바꾸기도 같은 유형 안에서만 일어난다) */
export async function compareCommonEditions(newId: string, deps: CommonCompareDeps): Promise<CompareOutcome> {
  const next = await deps.loadRow(newId);
  if (!next) return fail(404, '문서를 찾을 수 없습니다.');
  if (!next.replaces_id) return fail(409, '이 문서가 바꾼 옛 판이 없어 비교할 수 없습니다.');
  const prev = await deps.loadRow(next.replaces_id);
  if (!prev) return fail(404, '옛 판을 찾을 수 없습니다.');
  if (prev.org_type !== next.org_type) return fail(409, '같은 기관 유형의 두 판만 비교할 수 있습니다.');
  return compareEditionFiles(
    { side: commonSide(prev), fileName: prev.file_name, storagePath: prev.storage_path },
    { side: commonSide(next), fileName: next.file_name, storagePath: next.storage_path },
    deps
  );
}
