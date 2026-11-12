// src/lib/document-references-db.ts
// 문서 참조 관계의 DB·저장소 의존(서버) — 규칙은 document-references.ts, 라우트는
// `GET /api/documents/[id]/references`(한 문서)와 `POST /api/documents/references/build`(색인 만들기).
import { supabaseAdmin } from '@/lib/supabaseAdmin';
import { pagedRows } from '@/lib/paged-select';
import { isOrgType } from '@/lib/org-types';
import { readOriginalText } from '@/lib/source-original';
import { visibilityFilter } from '@/lib/department-scope';
import type { ActorScope } from '@/lib/agent-permissions';
import {
  REFERENCE_DOCUMENT_COLUMNS, candidateKeys, countCitations, similarCitation,
  type CitationCountRow, type OrgCitationCount,
  type AutoIndexDeps, type CommonReferenceRow, type IndexDeps, type PendingIndexRow, type ReferenceDeps, type ReferenceDocumentRow, type ReferenceIndex,
} from '@/lib/document-references';

/** 후보로 읽는 기관 문서 행 상한 */
const CANDIDATE_CAP = 5000;
/** 열쇠 하나로 찾는 인용 문서 상한 */
const CITING_PER_KEY = 200;
/** '이름 비슷'으로 다시 읽는 인용 문서 상한(2026-11-12) */
const SIMILAR_MAX = 200;

type Page<T> = PromiseLike<{ data: T[] | null; error: { message: string } | null; count?: number | null }>;

/** 참조 색인을 그 문서의 metadata에 합쳐 저장한다(다른 칸은 그대로). 실패는 false */
export async function saveReferenceIndex(id: string, organizationId: string, index: ReferenceIndex): Promise<boolean> {
  try {
    const { data, error } = await supabaseAdmin.from('documents').select('metadata').eq('id', id).eq('organization_id', organizationId).maybeSingle();
    if (error || !data) return false;
    const metadata = (data as { metadata?: unknown }).metadata;
    const base = metadata && typeof metadata === 'object' && !Array.isArray(metadata) ? (metadata as Record<string, unknown>) : {};
    const { data: updated, error: updateError } = await supabaseAdmin
      .from('documents')
      .update({ metadata: { ...base, references: index } })
      .eq('id', id)
      .eq('organization_id', organizationId)
      .select('id');
    return !updateError && (updated ?? []).length > 0;
  } catch {
    return false;
  }
}

/** 요청자가 볼 수 있는 기관 문서 중 색인된 수·전체 수(원본이 있는 것) */
export async function referenceCoverage(actor: ActorScope): Promise<{ indexed: number; total: number } | null> {
  if (!actor.organizationId) return null;
  const base = () => supabaseAdmin
    .from('documents')
    .select('id', { count: 'exact', head: true })
    .eq('organization_id', actor.organizationId!)
    .not('storage_path', 'is', null)
    .or(visibilityFilter(actor));
  const [total, indexed] = await Promise.all([base(), base().not('metadata->references', 'is', null)]);
  if (total.error || indexed.error || typeof total.count !== 'number' || typeof indexed.count !== 'number') return null;
  return { indexed: indexed.count, total: total.count };
}

export function referenceDeps(actor: ActorScope): ReferenceDeps {
  return {
    async loadDocument(id, organizationId) {
      const { data, error } = await supabaseAdmin.from('documents').select(REFERENCE_DOCUMENT_COLUMNS).eq('id', id).eq('organization_id', organizationId).maybeSingle();
      if (error) throw new Error(`documents: ${error.message}`);
      return (data as unknown as ReferenceDocumentRow | null) ?? null;
    },
    readText: readOriginalText,
    async listDocuments(organizationId) {
      const result = await pagedRows<ReferenceDocumentRow>((from, to, withCount) =>
        supabaseAdmin
          .from('documents')
          .select(`${REFERENCE_DOCUMENT_COLUMNS}, agent:agents(name, deleted_at)`, withCount ? { count: 'exact' } : undefined)
          .eq('organization_id', organizationId)
          .order('id')
          .range(from, to) as unknown as Page<ReferenceDocumentRow>,
      { cap: CANDIDATE_CAP });
      if (result.error) throw new Error(`documents: ${result.error.message}`);
      return { rows: result.data, truncated: result.truncated };
    },
    async listCommon(organizationId) {
      const { data: org, error } = await supabaseAdmin.from('organizations').select('type').eq('id', organizationId).maybeSingle();
      if (error) throw new Error(`organizations: ${error.message}`);
      const type = (org as { type?: unknown } | null)?.type;
      if (!isOrgType(type)) return [];
      // API는 한 번에 1,000행까지만 돌려준다 — 쪽마다 끝까지 읽는다
      const result = await pagedRows<CommonReferenceRow>((from, to, withCount) =>
        supabaseAdmin
          .from('common_documents')
          .select('id, title, file_name, edition_year, noda_status, retired_at', withCount ? { count: 'exact' } : undefined)
          .eq('org_type', type)
          .order('id')
          .range(from, to) as unknown as Page<CommonReferenceRow>,
      { cap: CANDIDATE_CAP });
      if (result.error) throw new Error(`common_documents: ${result.error.message}`);
      return result.data;
    },
    saveIndex: saveReferenceIndex,
    async listCiting(organizationId, keys) {
      // 색인 열쇠는 jsonb 배열 — 포함(@>)으로 찾는다. 열쇠마다 한 번
      const lists = await Promise.all(keys.map(async (key) => {
        const { data, error } = await supabaseAdmin
          .from('documents')
          .select(`${REFERENCE_DOCUMENT_COLUMNS}, agent:agents(name, deleted_at)`)
          .eq('organization_id', organizationId)
          .contains('metadata', { references: { keys: [key] } })
          .order('id')
          .limit(CITING_PER_KEY);
        if (error) throw new Error(`documents: ${error.message}`);
        return (data ?? []) as unknown as ReferenceDocumentRow[];
      }));
      return lists.flat();
    },
    async listSimilarCiting(organizationId, keys) {
      // 색인 열쇠만 쪽마다 읽어 '이름 비슷'을 가린 뒤 그 문서만 다시 읽는다(열쇠 부분 일치는 DB가 못 해 앱에서)
      const indexed = await pagedRows<{ id: string; keys: unknown }>((from, to, withCount) =>
        supabaseAdmin
          .from('documents')
          .select('id, keys:metadata->references->keys', withCount ? { count: 'exact' } : undefined)
          .eq('organization_id', organizationId)
          .eq('metadata->references->>status', 'ok')
          .order('id')
          .range(from, to) as unknown as Page<{ id: string; keys: unknown }>,
      { cap: CANDIDATE_CAP });
      if (indexed.error) throw new Error(`documents: ${indexed.error.message}`);
      const ids = indexed.data
        .filter((r) => Array.isArray(r.keys) && similarCitation((r.keys as unknown[]).filter((k): k is string => typeof k === 'string'), keys))
        .map((r) => r.id)
        .slice(0, SIMILAR_MAX);
      if (!ids.length) return [];
      const { data, error } = await supabaseAdmin
        .from('documents')
        .select(`${REFERENCE_DOCUMENT_COLUMNS}, agent:agents(name, deleted_at)`)
        .eq('organization_id', organizationId)
        .in('id', ids);
      if (error) throw new Error(`documents: ${error.message}`);
      return (data ?? []) as unknown as ReferenceDocumentRow[];
    },
    coverage: () => referenceCoverage(actor),
  };
}

/**
 * 공통 문서 하나를 인용하는 기관 수(슈퍼관리자, 2026-11-12) — 그 유형의 기관만, 같은 이름(색인 포함 조회)과 이름 비슷(색인 열쇠를 쪽마다 읽어 앱에서)을 기관마다 센다.
 * 문서 이름은 읽지도 돌려주지도 않는다. 공통 문서가 없으면 null
 */
export async function commonCitationCounts(commonId: string): Promise<{ document: { id: string; title: string; orgType: string; editionYear: number }; organizations: OrgCitationCount[]; orgCount: number; truncated: boolean } | null> {
  const { data: doc, error } = await supabaseAdmin.from('common_documents').select('id, org_type, title, file_name, edition_year').eq('id', commonId).maybeSingle();
  if (error) throw new Error(`common_documents: ${error.message}`);
  if (!doc) return null;
  const d = doc as { id: string; org_type: string; title: string; file_name: string; edition_year: number };
  const { data: orgRows, error: orgError } = await supabaseAdmin.from('organizations').select('id, name').eq('type', d.org_type).limit(1000);
  if (orgError) throw new Error(`organizations: ${orgError.message}`);
  const orgs = (orgRows ?? []) as Array<{ id: string; name: string }>;
  const base = { document: { id: d.id, title: d.title, orgType: d.org_type, editionYear: d.edition_year }, orgCount: orgs.length };
  const keys = candidateKeys(d.title, d.file_name);
  if (!orgs.length || !keys.length) return { ...base, organizations: [], truncated: false };
  const orgIds = orgs.map((o) => o.id);
  const COLUMNS = 'id, organization_id, noda_status, agent:agents(deleted_at)';
  // API는 한 번에 1,000행까지만 돌려준다 — 쪽마다 끝까지 읽는다
  const exactLists = await Promise.all(keys.map(async (key) => {
    const result = await pagedRows<CitationCountRow>((from, to, withCount) =>
      supabaseAdmin.from('documents').select(COLUMNS, withCount ? { count: 'exact' } : undefined).in('organization_id', orgIds)
        .contains('metadata', { references: { keys: [key] } }).order('id').range(from, to) as unknown as Page<CitationCountRow>,
    { cap: 20_000 });
    if (result.error) throw new Error(`documents: ${result.error.message}`);
    return result;
  }));
  const indexed = await pagedRows<CitationCountRow>((from, to, withCount) =>
    supabaseAdmin
      .from('documents')
      .select(`${COLUMNS}, keys:metadata->references->keys`, withCount ? { count: 'exact' } : undefined)
      .in('organization_id', orgIds)
      .eq('metadata->references->>status', 'ok')
      .order('id')
      .range(from, to) as unknown as Page<CitationCountRow>,
  { cap: 20_000 });
  if (indexed.error) throw new Error(`documents: ${indexed.error.message}`);
  return { ...base, organizations: countCitations(orgs, exactLists.flatMap((l) => l.data), indexed.data, keys), truncated: indexed.truncated || exactLists.some((l) => l.truncated) };
}

/** 5분 실행기의 색인 자동 채우기(2026-11-12) — 모든 기관의 색인 없는 문서(최근 것부터), 그 문서의 기관으로만 저장 */
export function autoIndexDeps(): AutoIndexDeps {
  return {
    async listPendingAll(limit) {
      const { data, error } = await supabaseAdmin
        .from('documents')
        .select('id, department_id, organization_id, visibility, storage_path, file_name, noda_status')
        .not('organization_id', 'is', null)
        .is('metadata->references', null)
        .order('created_at', { ascending: false })
        .limit(limit);
      if (error) throw new Error(`documents: ${error.message}`);
      return (data ?? []) as PendingIndexRow[];
    },
    readText: readOriginalText,
    saveIndex: saveReferenceIndex,
    now: () => Date.now(),
    random: () => Math.random(),
  };
}

export function indexDeps(actor: ActorScope): IndexDeps {
  return {
    async listPending(organizationId, limit) {
      const { data, error } = await supabaseAdmin
        .from('documents')
        .select('id, department_id, organization_id, visibility, storage_path, file_name, noda_status')
        .eq('organization_id', organizationId)
        .or(visibilityFilter(actor))
        .is('metadata->references', null)
        .order('created_at', { ascending: false })
        .limit(limit);
      if (error) throw new Error(`documents: ${error.message}`);
      return (data ?? []) as PendingIndexRow[];
    },
    readText: readOriginalText,
    saveIndex: saveReferenceIndex,
    coverage: referenceCoverage,
    now: () => Date.now(),
  };
}
