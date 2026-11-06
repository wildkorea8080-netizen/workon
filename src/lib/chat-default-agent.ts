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

export function pickDefaultAgent(rows: Agent[], lastUsedAgentId: string | null | undefined): Agent | null {
  const choices = chatAgentChoices(rows);
  if (lastUsedAgentId) {
    const last = choices.find((a) => a.id === lastUsedAgentId);
    if (last) return last;
  }
  return choices.find((a) => a.tier === 'official') ?? choices[0] ?? null;
}
