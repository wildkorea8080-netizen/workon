// 답변 평가의 꼴(2026-11-05, 0064) — 화면도 읽으므로 아무것도 import하지 않는다
export type FeedbackRating = 'up' | 'down';
export type FeedbackReason = 'wrong' | 'no_evidence' | 'incomplete' | 'format' | 'other';
/** 아쉬운 이유 — 정해 둔 코드만(자유 글을 받지 않는다). 화면 단추와 서버 검사·요약이 같은 표를 본다 */
export const FEEDBACK_REASONS: Record<FeedbackReason, string> = {
  wrong: '내용이 틀림',
  no_evidence: '근거가 부족함',
  incomplete: '답이 덜 됨',
  format: '형식·표현',
  other: '기타',
};
export const isFeedbackReason = (v: unknown): v is FeedbackReason => typeof v === 'string' && Object.prototype.hasOwnProperty.call(FEEDBACK_REASONS, v);
export interface MessageFeedback { rating: FeedbackRating; reason: FeedbackReason | null }

/** 요청 본문 → 평가. `rating: null`은 지우기. 꼴이 틀리면 null(400) */
export function parseFeedback(body: unknown): { rating: null } | MessageFeedback | null {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return null;
  const { rating, reason } = body as { rating?: unknown; reason?: unknown };
  if (rating === null) return reason === undefined || reason === null ? { rating: null } : null;
  if (rating === 'up') return reason === undefined || reason === null ? { rating, reason: null } : null;
  if (rating === 'down') {
    if (reason === undefined || reason === null) return { rating, reason: null };
    return isFeedbackReason(reason) ? { rating, reason } : null;
  }
  return null;
}

export interface FeedbackAgentSummary {
  agentId: string | null;
  agentName: string;
  up: number;
  down: number;
  /** 도움됨 비율(%, 소수 첫째 자리) — 평가가 없으면 null */
  helpfulPercent: number | null;
  reasons: Record<FeedbackReason, number>;
}
export interface FeedbackSummary { total: { up: number; down: number; helpfulPercent: number | null }; agents: FeedbackAgentSummary[]; truncated: boolean }

const percent = (up: number, down: number) => (up + down ? Math.round((up / (up + down)) * 1000) / 10 : null);
const emptyReasons = (): Record<FeedbackReason, number> => ({ wrong: 0, no_evidence: 0, incomplete: 0, format: 0, other: 0 });

/**
 * 평가 행 → 비서별 요약(순수). 평가 수가 많은 비서부터. 이름을 모르는(지운) 비서는 '지운 비서', 비서 없는 행은 '비서 없음'으로 묶는다.
 * 나만의 비서는 이름을 싣지 않고 '나만의 비서'로 묶는다 — 관리자 화면에 직원 개인 비서 이름이 나오지 않게
 */
export function summarizeFeedback(
  rows: { agent_id: string | null; rating: string; reason: string | null }[],
  agents: Map<string, { name: string; personal: boolean }>,
  truncated = false
): FeedbackSummary {
  const groups = new Map<string, FeedbackAgentSummary>();
  let up = 0;
  let down = 0;
  for (const row of rows) {
    if (row.rating !== 'up' && row.rating !== 'down') continue;
    const agent = row.agent_id ? agents.get(row.agent_id) : undefined;
    const key = !row.agent_id ? 'none' : !agent ? 'deleted' : agent.personal ? 'personal' : row.agent_id;
    const name = key === 'none' ? '비서 없음' : key === 'deleted' ? '지운 비서' : key === 'personal' ? '나만의 비서' : agent!.name;
    const group = groups.get(key) ?? { agentId: key === row.agent_id ? row.agent_id : null, agentName: name, up: 0, down: 0, helpfulPercent: null, reasons: emptyReasons() };
    if (row.rating === 'up') { group.up += 1; up += 1; } else { group.down += 1; down += 1; if (isFeedbackReason(row.reason)) group.reasons[row.reason] += 1; }
    groups.set(key, group);
  }
  const list = [...groups.values()].map((g) => ({ ...g, helpfulPercent: percent(g.up, g.down) }));
  list.sort((a, b) => b.up + b.down - (a.up + a.down) || a.agentName.localeCompare(b.agentName, 'ko'));
  return { total: { up, down, helpfulPercent: percent(up, down) }, agents: list, truncated };
}
