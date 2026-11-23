import type { Agent } from '@/lib/db';

/**
 * AI 대화 첫 화면에서 비서를 고르지 않고 바로 물을 때 답할 비서(2026-11-06) — 알리웍스·웍스AI처럼 입력창에 바로 묻게 한다.
 * 몰래 고르지 않는다: 첫 화면이 '답할 비서: 이름'을 보이고, 아래에서 다른 비서를 고르면 그 비서가 답한다.
 * 순서: ① 마지막으로 대화한 비서(지금도 쓸 수 있으면) ② 공식 비서 중 첫째(관리자가 정한 노출 순서) ③ 쓸 수 있는 첫 비서.
 * 화면이 받은 목록(서버가 권한으로 거른 것)에서만 고른다 — 실제 권한은 대화 실행기가 다시 본다
 */
export function chatAgentChoices(rows: Agent[]): Agent[] {
  const seen = new Set<string>();
  return rows.filter((a) => {
    if (!a?.id || seen.has(a.id)) return false;
    seen.add(a.id);
    return a.is_active !== false && !a.deleted_at && a.agent_type !== 'link' && !a.app_definition;
  });
}

/**
 * 첫 화면이 읽은 세 목록(공식·부서 비서, 나만의 비서, 마지막 대화)으로 답할 비서를 정한다 — 하나라도 못 읽었으면(null) 고르지 않는다(2026-11-21).
 * 예전엔 못 읽은 목록을 빈 목록으로 보아, 마지막 대화를 못 읽으면 마지막으로 쓴 비서가 아니라 첫 공식 비서를 골랐고
 * 업무 홈 '바로 묻기'로 넘긴 질문이 직원이 고르지 않은 비서에게 곧바로 갔다(비서마다 문서·기능이 다르다). 못 정하면 질문을 입력창에 남긴다
 */
export const DEFAULT_AGENT_UNREAD = '답할 비서를 지금 정하지 못했습니다(비서 목록이나 지난 대화를 불러오지 못함) — 아래에서 비서를 고르면 적은 질문으로 대화를 시작합니다.';

export function chooseDefaultAgent(
  shared: Agent[] | null,
  personal: Agent[] | null,
  recent: Array<{ agent?: unknown }> | null,
): { agent: Agent | null; unread: boolean } {
  if (!shared || !personal || !recent) return { agent: null, unread: true };
  const last = recent[0]?.agent as { id?: string } | Array<{ id?: string }> | null | undefined;
  const lastId = (Array.isArray(last) ? last[0]?.id : last?.id) ?? null;
  return { agent: pickDefaultAgent([...shared, ...personal], lastId), unread: false };
}

export function pickDefaultAgent(rows: Agent[], lastUsedAgentId: string | null | undefined): Agent | null {
  const choices = chatAgentChoices(rows);
  if (lastUsedAgentId) {
    const last = choices.find((a) => a.id === lastUsedAgentId);
    if (last) return last;
  }
  return choices.find((a) => a.tier === 'official') ?? choices[0] ?? null;
}
