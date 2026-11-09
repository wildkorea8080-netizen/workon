// src/lib/apps/app-doc-lookup.ts
// 입력형 앱의 '문서 찾기' 조회 단계(2026-11-09) — 조회어로 **대화와 같은 찾기**(`searchLikeChat` — 이 앱 비서의 문서 + 기관 유형의 공통 자료실,
// 판·시행일 규칙·유사도 하한 0.80까지 같다)를 한 번 하고, 근거 글을 다음 단계의 자료로 넘긴다. 모델을 부르지 않는다(사용량 없음).
//
// - 근거를 찾으면 `[n] 문서 이름 · 위치` 머리 줄 + 근거 글(조각마다 대화 근거 창과 같은 2,000자까지 — 전체는 단계 결과 상한 6,000자).
//   출처는 문서마다 하나, 문서 원본 주소(`/api/documents/{id}/original` — 열 때 권한을 서버가 다시 본다).
// - 근거가 없으면 **멈추지 않고** '근거 없음' 안내와 `gap`으로 넘긴다 — 다음 단계가 결과에 '정보 공백(확인 필요)'으로 밝힌다(조사 앱의 공백 확인).
// - 문서를 지금 불러오지 못하면(NODA 장애) 실패 — 근거 없는 답을 근거 있는 답처럼 내지 않는다(대화의 503과 같은 판단).
import type { RetrievedChunk } from '@/lib/db';
import { supabaseAdmin } from '@/lib/supabaseAdmin';
import { AGENT_ACCESS_COLUMNS, canUseAgent, type ActorScope, type AgentAccessInfo } from '@/lib/agent-permissions';
import { searchLikeChat } from '@/lib/capabilities/doc-search';
import { sourceLocationLabel, sourceOriginalHref, sourceTitleLabel } from '@/components/chat/source-label';
import { APP_LOOKUP_SOURCES_MAX, type AppDocSearchRunner, type AppStepSource } from './pipeline';

export const APP_DOC_LOOKUP_GAP = '이 조회어로 문서함(이 비서의 문서·기관 유형의 공통 기준)에서 근거를 찾지 못했습니다 — 정보 공백입니다.';
export const APP_DOC_LOOKUP_UNAVAILABLE = '참고 문서를 지금 불러오지 못했습니다 — 잠시 뒤 다시 실행해 주세요.';

/** 근거 조각 → 다음 단계에 넘길 글과 출처(문서마다 하나, 처음 나온 쪽으로) */
export function docLookupResult(chunks: RetrievedChunk[]): { content: string; sources: AppStepSource[]; gap?: boolean } {
  if (!chunks.length) return { content: APP_DOC_LOOKUP_GAP, sources: [], gap: true };
  const blocks: string[] = [];
  const sources: AppStepSource[] = [];
  const seen = new Set<string>();
  chunks.forEach((c, i) => {
    const n = typeof c.n === 'number' ? c.n : i + 1;
    const title = sourceTitleLabel(c);
    blocks.push(`[${n}] ${title} · ${sourceLocationLabel({ ...c, similarity: null })}\n${(c.text ?? '').trim() || '(근거 글 없음)'}`);
    const key = `${c.scope ?? 'agent'}:${c.documentId}`;
    const url = sourceOriginalHref(c);
    if (!seen.has(key) && url && sources.length < APP_LOOKUP_SOURCES_MAX) { seen.add(key); sources.push({ title, url }); }
  });
  return { content: blocks.join('\n\n'), sources };
}

export const APP_DOC_LOOKUP_AGENT_DENIED = '이 단계가 찾을 비서의 문서함을 지금 쓸 수 없습니다.';
/** 태그로 좁혔더니 남은 근거가 없을 때 — 멈추지 않고 정보 공백으로 넘긴다 */
export const appDocLookupTagGap = (tags: readonly string[]) => `이 조회어로 태그 '${tags.join(', ')}'이(가) 붙은 문서에서 근거를 찾지 못했습니다 — 정보 공백입니다.`;

/**
 * 태그로 좁히기(2026-11-09) — 이 기관 문서(공통 기준 아님) 중 태그 하나라도 맞는 문서의 조각만(대소문자 무시, 순서·번호 그대로).
 * NODA `/context`에 문서 거르기가 없어 찾은 뒤에 거른다 — 근거가 적게 남을 수 있다
 */
export function filterChunksByTags(chunks: RetrievedChunk[], docTags: ReadonlyMap<string, readonly string[]>, tags: readonly string[]): RetrievedChunk[] {
  const want = new Set(tags.map((t) => t.toLocaleLowerCase('ko')));
  return chunks.filter((c) => c.scope !== 'common' && (docTags.get(c.documentId) ?? []).some((t) => want.has(t.toLocaleLowerCase('ko'))));
}

/**
 * 이번 턴의 비서·기관으로 찾는 실행기 — 비서·기관은 서버가 채운 턴 정보에서만(조회어 말고는 입력을 받지 않는다).
 * 다른 비서(`agent`)는 실행 전에 권한을 확인한 목록(`allowedAgents` — `checkLookupAgents`)에 있을 때만 그 비서로 찾는다
 */
export function appDocSearchRunner(
  ctx: { agentId: string; organizationId: string; capabilities?: { doc_search?: object } },
  search: (input: { agentId: string; organizationId: string; query: string }) => Promise<RetrievedChunk[] | null> = searchLikeChat,
  allowedAgents: readonly string[] = [],
  loadTags: (ids: string[]) => Promise<Map<string, string[]> | null> = loadDocumentTags,
): AppDocSearchRunner {
  return async (query, agent, tags) => {
    const target = agent && agent !== ctx.agentId.toLowerCase() ? agent : ctx.agentId;
    if (target !== ctx.agentId && !allowedAgents.includes(target)) return { content: APP_DOC_LOOKUP_AGENT_DENIED, sources: [], isError: true };
    // 이 앱 비서 자신을 '다른 비서'로 적어 둔 단계 — 이 앱의 문서 찾기 능력을 그대로 본다(능력 확인을 건너뛰는 길이 되지 않게)
    if (target === ctx.agentId && agent && ctx.capabilities && !ctx.capabilities.doc_search) return { content: '이 앱 비서에 문서 찾기가 꺼져 있습니다. 앱 설정을 다시 저장하거나 관리자에게 문의하세요.', sources: [], isError: true };
    try {
      const chunks = await search({ agentId: target, organizationId: ctx.organizationId, query });
      if (!chunks) return { content: APP_DOC_LOOKUP_UNAVAILABLE, sources: [], isError: true };
      if (tags?.length) {
        // 태그를 읽지 못하면 거른 척하지 않고 멈춘다(근거 없는 답을 근거 있는 답처럼 내지 않는다)
        const ids = [...new Set(chunks.filter((c) => c.scope !== 'common').map((c) => c.documentId))];
        const docTags = ids.length ? await loadTags(ids) : new Map<string, string[]>();
        if (!docTags) return { content: APP_DOC_LOOKUP_UNAVAILABLE, sources: [], isError: true };
        const kept = filterChunksByTags(chunks, docTags, tags);
        if (!kept.length) return { content: appDocLookupTagGap(tags), sources: [], gap: true };
        return docLookupResult(kept);
      }
      return docLookupResult(chunks);
    } catch {
      return { content: APP_DOC_LOOKUP_UNAVAILABLE, sources: [], isError: true };
    }
  };
}

export interface LookupAgentRow extends AgentAccessInfo { name?: string | null; capabilities?: Record<string, unknown> | null; agent_type?: string | null }
export const lookupAgentDenied = (name: string | null | undefined) => `이 앱의 문서 찾기 단계가 찾을 비서${name ? ` '${String(name).slice(0, 40)}'` : ''}를 쓸 수 없습니다. 앱을 만든 사람에게 찾을 비서를 바꿔 달라고 하세요.`;

/**
 * 실행 전 — 문서 찾기 단계가 찾을 다른 비서마다 **실행하는 사람이 그 비서를 쓸 수 있고**(`canUseAgent` — 같은 기관·지우지 않음·켜짐·단계별 공개 범위),
 * 그 비서에 문서 찾기가 켜져 있는지 본다. 하나라도 아니면 실행하지 않는다(대화를 만들기 전에 거절). 비서를 읽지 못하면 닫는다
 */
export async function checkLookupAgents(
  ids: readonly string[],
  actor: ActorScope,
  load: (ids: readonly string[]) => Promise<LookupAgentRow[] | null> = loadLookupAgents,
): Promise<{ ok: true } | { ok: false; message: string }> {
  if (!ids.length) return { ok: true };
  const rows = await load(ids);
  if (!rows) return { ok: false, message: lookupAgentDenied(null) };
  for (const id of ids) {
    const row = rows.find((r) => r.id === id);
    if (!row || row.agent_type === 'link' || !canUseAgent(row, actor) || !row.capabilities || typeof row.capabilities !== 'object' || !('doc_search' in row.capabilities)) {
      return { ok: false, message: lookupAgentDenied(row?.name) };
    }
  }
  return { ok: true };
}

async function loadDocumentTags(ids: string[]): Promise<Map<string, string[]> | null> {
  const { data, error } = await supabaseAdmin.from('documents').select('id, tags').in('id', ids);
  if (error) return null;
  return new Map(((data ?? []) as Array<{ id: string; tags: unknown }>).map((d) => [d.id, Array.isArray(d.tags) ? d.tags.filter((t): t is string => typeof t === 'string') : []]));
}

async function loadLookupAgents(ids: readonly string[]): Promise<LookupAgentRow[] | null> {
  const { data, error } = await supabaseAdmin.from('agents').select(`${AGENT_ACCESS_COLUMNS}, name, capabilities, agent_type`).in('id', [...ids]);
  if (error) return null;
  return (data ?? []) as unknown as LookupAgentRow[];
}
