import { chatTokensOf } from '@/lib/org-chat-tokens';

/**
 * 내 사용현황의 토큰 — **기록한 실제 사용량**(`usage_logs`의 입력+출력 토큰, 숫자가 아니면 0)으로 센다(2026-11-18).
 *
 * 예전엔 대화 글자 수 ÷ 4로 어림했다. 한글은 글자당 토큰이 훨씬 많고, 시스템 프롬프트·참고 문서·도구 결과·첨부는
 * 메시지 글에 없어 실제의 몇 분의 일로 보였다 — 개인 월 한도 알림 메일이 이 화면으로 보내는데 숫자가 한도 판정과 무관했다.
 * 대화뿐 아니라 토큰을 쓴 모든 활동(업무 작업·답변 고쳐 쓰기 등)을 센다 — 관리자 이용통계의 직원별과 같은 범위.
 */
export interface UsageRow {
  details: unknown;
  created_at: string;
}

export interface MyTokenTotals {
  /** 이번 달(한국 시간 1일부터) */
  monthly: number;
  /** 고른 기간 안, 비서별(`details.agent_id`가 있는 기록만) */
  byAgent: Map<string, number>;
}

export function sumMyTokens(
  rows: UsageRow[],
  range: { monthStartMs: number; periodStartMs: number; periodEndMs: number },
): MyTokenTotals {
  let monthly = 0;
  const byAgent = new Map<string, number>();
  for (const r of rows) {
    const tokens = chatTokensOf(r.details);
    if (tokens <= 0) continue;
    const at = Date.parse(r.created_at);
    if (!Number.isFinite(at)) continue;
    if (at >= range.monthStartMs) monthly += tokens;
    if (at >= range.periodStartMs && at <= range.periodEndMs) {
      const agentId = (r.details as { agent_id?: unknown } | null)?.agent_id;
      if (typeof agentId === 'string' && agentId) byAgent.set(agentId, (byAgent.get(agentId) ?? 0) + tokens);
    }
  }
  return { monthly, byAgent };
}
