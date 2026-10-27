// src/lib/work/workflows/regulations/providers.ts
import { supabaseAdmin } from '@/lib/supabaseAdmin';
import { NODA_API_KEY } from '@/lib/config';
import { noda, nodaTenant, stripNodaPrefixes, CONTEXT_BUDGET_AGENT_SHARED, CONTEXT_BUDGET_COMMON_SHARED } from '@/lib/noda';
import { contextPassages, sourcesToChunks, isCleanMatch, type AgentDocument } from '@/lib/capabilities/doc-search';
import { commonSourcesToChunks, citableCommonIds, type CommonSearchDoc } from '@/lib/capabilities/doc-search-common';
import { commonTenant, isOrgType } from '@/lib/org-types';
import { getAccessScope } from '@/lib/department-scope';
import { lawConnector } from '@/lib/connectors/law';
import { logSystem } from '@/lib/logger';
import type { RetrievedChunk } from '@/lib/db';
import { sameLocalGovernment, type RawEvidence } from './evidence';
import { parseLawSearch, pickArticles, splitArticles, type ProviderResult, type RegulationProviders } from './gather';

/**
 * 운영 근거 제공자 — 대화의 문서 찾기(doc-search)와 같은 맞추기 규칙을 쓴다.
 *
 *  - 기관 문서: 이 직원이 쓸 수 있는 **공식 비서**(노출 중·활성·같은 기관·공개 범위 안)의 `ready` 문서 보관함만, 최대 3곳.
 *    근거가 그 비서의 행과 하나라도 안 맞으면(섞임·고아) 그 보관함의 근거는 버린다 — 대화와 같은 원칙
 *  - 공통 자료실: 기관 유형의 현재 판만(`citableCommonIds`)
 *  - 법령: 법제처 이름 검색 → 본문 → 핵심어가 맞는 조문만. 지방자치단체면 자치법규도 찾되 다른 지자체 것은
 *    본문을 가져오지 않고 '제외' 근거로만 남긴다
 */
const MAX_AGENT_VAULTS = 3;
const MAX_LAWS = 4;
const ARTICLES_PER_LAW = 2;

function locationOf(c: RetrievedChunk): string | null {
  const parts = [c.page ? `p.${c.page}` : null, c.cellRange ? stripNodaPrefixes(c.cellRange) : null, c.section ? stripNodaPrefixes(c.section) : null].filter(Boolean);
  return parts.length ? parts.join(' · ') : null;
}

function chunkEvidence(c: RetrievedChunk, kind: 'org_doc' | 'common', editionYear: number | null): RawEvidence | null {
  if (!c.text.trim()) return null;
  return {
    kind,
    title: stripNodaPrefixes(c.documentTitle || '제목 없는 문서'),
    location: locationOf(c),
    effectiveDate: null,
    editionYear,
    issuer: null,
    text: stripNodaPrefixes(c.text),
    url: null,
  };
}

async function orgDocuments(scope: { organizationId: string; departmentId: string }, query: string): Promise<ProviderResult> {
  if (!NODA_API_KEY) return { status: 'unavailable', reason: '문서 검색(NODA) 키가 설정되지 않았습니다' };
  const access = await getAccessScope(scope.departmentId);
  const { data, error } = await supabaseAdmin
    .from('agents')
    .select('id, visibility, department_id, capabilities')
    .eq('organization_id', scope.organizationId)
    .eq('tier', 'official')
    .eq('is_published', true)
    .eq('is_active', true)
    .is('deleted_at', null);
  if (error) throw new Error(error.message);
  const agents = ((data ?? []) as { id: string; visibility: string; department_id: string; capabilities: Record<string, unknown> | null }[]).filter(
    (a) => a.capabilities && 'doc_search' in a.capabilities && (a.visibility === 'organization' || access.visibleDepartmentIds.includes(a.department_id))
  );
  if (!agents.length) return { status: 'ok', items: [] };
  const { data: docRows, error: docErr } = await supabaseAdmin
    .from('documents')
    .select('id, title, file_name, noda_status, agent_id')
    .in('agent_id', agents.map((a) => a.id));
  if (docErr) throw new Error(docErr.message);
  const docsByAgent = new Map<string, AgentDocument[]>();
  for (const d of (docRows ?? []) as (AgentDocument & { agent_id: string })[]) docsByAgent.set(d.agent_id, [...(docsByAgent.get(d.agent_id) ?? []), d]);
  const vaults = agents
    .map((a) => ({ id: a.id, docs: docsByAgent.get(a.id) ?? [] }))
    .filter((a) => a.docs.some((d) => d.noda_status === 'ready'))
    .sort((x, y) => y.docs.length - x.docs.length)
    .slice(0, MAX_AGENT_VAULTS);
  const items: RawEvidence[] = [];
  const results = await Promise.all(vaults.map((v) => noda.getContext({ tenant: nodaTenant(v.id), query, budget: CONTEXT_BUDGET_AGENT_SHARED })));
  results.forEach((res, i) => {
    const match = sourcesToChunks(res.sources, vaults[i].docs, contextPassages(res.context));
    if (!isCleanMatch(match)) {
      void logSystem({ level: 'warning', category: 'security', message: '업무 규정 확인: 비서 보관함 근거가 문서 행과 맞지 않아 버림', details: { agent_id: vaults[i].id, unknown: match.unknown.length, unparsable: match.unparsable.length, malformed: match.malformed } });
      return;
    }
    for (const c of match.chunks) {
      const e = chunkEvidence(c, 'org_doc', null);
      if (e) items.push(e);
    }
  });
  return { status: 'ok', items };
}

async function common(scope: { organizationId: string }, query: string): Promise<ProviderResult> {
  if (!NODA_API_KEY) return { status: 'unavailable', reason: '문서 검색(NODA) 키가 설정되지 않았습니다' };
  const { data: org, error } = await supabaseAdmin.from('organizations').select('type').eq('id', scope.organizationId).maybeSingle();
  if (error) throw new Error(error.message);
  const type = (org as { type: unknown } | null)?.type;
  if (!isOrgType(type)) return { status: 'unavailable', reason: '기관 유형이 정해지지 않아 공통 기준 자료를 찾지 않았습니다' };
  const { data: rows, error: rowsErr } = await supabaseAdmin
    .from('common_documents')
    .select('id, title, edition_year, org_type, noda_status, retired_at, replaces_id')
    .eq('org_type', type);
  if (rowsErr) throw new Error(rowsErr.message);
  const docs = (rows ?? []) as CommonSearchDoc[];
  if (citableCommonIds(docs).size === 0) return { status: 'ok', items: [] };
  const res = await noda.getContext({ tenant: commonTenant(type), query, budget: CONTEXT_BUDGET_COMMON_SHARED });
  const match = commonSourcesToChunks(res.sources, docs, contextPassages(res.context), 0);
  if (!isCleanMatch(match)) {
    void logSystem({ level: 'warning', category: 'security', message: '업무 규정 확인: 공통 보관함 근거가 문서 행과 맞지 않아 버림', details: { unknown: match.unknown.length, unparsable: match.unparsable.length, malformed: match.malformed } });
    return { status: 'ok', items: [] };
  }
  const items = match.chunks.map((c) => chunkEvidence(c, 'common', typeof c.editionYear === 'number' ? c.editionYear : null)).filter((e): e is RawEvidence => e !== null);
  return { status: 'ok', items };
}

async function lawTool(name: string, input: Record<string, unknown>) {
  const r = await lawConnector.execute(name, input);
  // 커넥터가 이미 세 번 다시 시도했다 — 그래도 실패면 실행을 다시 시도하게 던진다
  if (r.isError && !/찾지 못했습니다/.test(r.content)) throw new Error('law connector failed');
  return r;
}

async function laws(scope: { organizationId: string; organizationName: string | null }, plan: { lawQueries: string[]; keywords: string[] }): Promise<ProviderResult> {
  if (!lawConnector.isConfigured()) return { status: 'unavailable', reason: '국가법령정보 연결이 설정되지 않았습니다' };
  if (!plan.lawQueries.length) return { status: 'ok', items: [] };
  const { data: org } = await supabaseAdmin.from('organizations').select('type').eq('id', scope.organizationId).maybeSingle();
  const isLocal = (org as { type?: unknown } | null)?.type === '지방자치단체';
  const items: RawEvidence[] = [];
  const seen = new Set<string>();

  const searches: { type: '법령' | '자치법규'; query: string }[] = [
    ...plan.lawQueries.map((query) => ({ type: '법령' as const, query })),
    ...(isLocal ? plan.lawQueries.slice(0, 2).map((query) => ({ type: '자치법규' as const, query })) : []),
  ];
  for (const s of searches) {
    const found = await lawTool('law_search', { query: s.query, type: s.type, limit: s.type === '법령' ? 2 : 3 });
    for (const row of parseLawSearch(found.content)) {
      if (seen.has(`${s.type}:${row.id}`) || seen.size >= MAX_LAWS * 2) continue;
      seen.add(`${s.type}:${row.id}`);
      if (s.type === '자치법규') {
        if (!sameLocalGovernment(scope.organizationName, row.issuer)) {
          items.push({ kind: 'ordinance', title: row.title, location: null, effectiveDate: row.effectiveDate, editionYear: null, issuer: row.issuer, text: '(다른 지자체의 자치법규 — 본문을 가져오지 않음)', url: null });
          continue;
        }
      }
      const content = await lawTool('law_get_content', { id: row.id, type: s.type });
      if (content.isError) continue;
      const { enforced, articles } = splitArticles(content.content);
      for (const a of pickArticles(articles, plan.keywords, ARTICLES_PER_LAW)) {
        items.push({
          kind: s.type === '법령' ? 'law' : 'ordinance',
          title: row.title,
          location: a.heading,
          effectiveDate: row.effectiveDate ?? enforced,
          editionYear: null,
          issuer: row.issuer,
          text: a.text,
          url: content.sources[0]?.url ?? null,
        });
      }
    }
  }
  return { status: 'ok', items };
}

export const defaultRegulationProviders: RegulationProviders = {
  orgDocuments: (scope, query) => orgDocuments(scope, query),
  common: (scope, query) => common(scope, query),
  laws: (scope, plan) => laws(scope, plan),
};
