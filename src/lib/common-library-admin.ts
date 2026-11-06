import { citableCommonIds } from '@/lib/capabilities/doc-search-common';
import { isOrgType, type OrgType } from '@/lib/org-types';

/**
 * 기관 관리자가 보는 공통 자료실(2026-11-06) — 이 기관 유형에서 문서 찾기 비서가 **지금 근거로 쓰는** 정부 기준 문서 목록.
 * 공통 자료실은 운영자(슈퍼관리자)가 관리하고 기관은 고치지 못한다. 예전에는 기관 관리자가 어떤 공통 문서가 쓰이는지
 * 볼 곳이 없어, 직원 답의 `[공통]` 칩으로만 알았다(S5 알려진 한계).
 *
 * - 대화와 같은 규칙(`citableCommonIds` — `ready` 현재 판, `ready` 새 판이 대신한 옛 판은 뺌)으로 고른다
 * - 저장소 경로·NODA 칸은 내보내지 않는다. 원본은 `/api/common-documents/[id]/original`(같은 유형 직원이면 열림)
 * - 아직 근거로 쓰지 않는 현재 판(읽는 중·실패 등)은 개수만 — 기관이 손쓸 수 있는 일이 아니다
 */
export const ADMIN_COMMON_COLUMNS =
  'id, org_type, title, edition_year, usage_terms, file_name, size_bytes, noda_status, retired_at, replaces_id, created_at';

export interface CommonLibraryRow {
  id: string;
  org_type: string;
  title: string;
  edition_year: number;
  usage_terms: string;
  file_name: string;
  size_bytes: number | null;
  noda_status: string;
  retired_at: string | null;
  replaces_id: string | null;
  created_at: string;
}

export interface AdminCommonDocument {
  id: string;
  title: string;
  editionYear: number;
  usageTerms: string;
  fileName: string;
  sizeBytes: number | null;
  createdAt: string;
}

export interface AdminCommonLibrary {
  /** 기관 유형 — 없거나 표 밖이면 null(공통 자료실이 없음) */
  orgType: OrgType | null;
  documents: AdminCommonDocument[];
  /** 현재 판이지만 아직 근거로 쓰지 않는 것(읽는 중·실패·판 바뀌는 중) */
  pendingCount: number;
}

/** 행 → 목록. 근거로 쓰는 현재 판만, 이름 순(같으면 새 연도 먼저) */
export function adminCommonList(orgType: unknown, rows: CommonLibraryRow[]): AdminCommonLibrary {
  if (!isOrgType(orgType)) return { orgType: null, documents: [], pendingCount: 0 };
  const citable = citableCommonIds(rows as unknown as Parameters<typeof citableCommonIds>[0]);
  const current = rows.filter((r) => !r.retired_at && r.noda_status !== 'retired' && r.noda_status !== 'deleting');
  const documents = current
    .filter((r) => citable.has(r.id.toLowerCase()))
    .map((r) => ({
      id: r.id,
      title: r.title,
      editionYear: r.edition_year,
      usageTerms: r.usage_terms,
      fileName: r.file_name,
      sizeBytes: typeof r.size_bytes === 'number' ? r.size_bytes : null,
      createdAt: r.created_at,
    }))
    .sort((a, b) => a.title.localeCompare(b.title, 'ko') || b.editionYear - a.editionYear);
  return { orgType, documents, pendingCount: current.length - documents.length };
}
