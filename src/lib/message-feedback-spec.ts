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
/**
 * `savedMinutes`(2026-11-10, 0082) — '도움됨'일 때만, 직원이 고른 '이 답으로 줄인 시간'(분, 1~480). **직원의 자기 신고**이고 측정·추정이 아니다.
 * 화면은 정해 둔 단추(10분·30분·1시간·2시간·반나절)만 보이고 서버는 1~480 정수를 받는다
 */
export interface MessageFeedback { rating: FeedbackRating; reason: FeedbackReason | null; savedMinutes?: number | null }
export const FEEDBACK_SAVED_MINUTES_MAX = 480;
export const FEEDBACK_SAVED_MINUTE_CHOICES: Array<{ minutes: number; label: string }> = [
  { minutes: 10, label: '10분' }, { minutes: 30, label: '30분' }, { minutes: 60, label: '1시간' }, { minutes: 120, label: '2시간' }, { minutes: 240, label: '반나절' },
];
const isSavedMinutes = (v: unknown): v is number => typeof v === 'number' && Number.isInteger(v) && v >= 1 && v <= FEEDBACK_SAVED_MINUTES_MAX;

/** 요청 본문 → 평가. `rating: null`은 지우기. 꼴이 틀리면 null(400) */
export function parseFeedback(body: unknown): { rating: null } | MessageFeedback | null {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return null;
  const { rating, reason, saved_minutes: saved } = body as { rating?: unknown; reason?: unknown; saved_minutes?: unknown };
  const noSaved = saved === undefined || saved === null;
  if (rating === null) return (reason === undefined || reason === null) && noSaved ? { rating: null } : null;
  if (rating === 'up') {
    if (!(reason === undefined || reason === null)) return null;
    if (noSaved) return { rating, reason: null };
    return isSavedMinutes(saved) ? { rating, reason: null, savedMinutes: saved } : null;
  }
  if (rating === 'down') {
    if (!noSaved) return null;
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
  /** 직원이 스스로 고른 '줄인 시간' 합(분)과 고른 답 수(0082) — 자기 신고, 측정·추정 아님 */
  savedMinutes: number;
  savedReports: number;
}
export interface FeedbackSummary { total: { up: number; down: number; helpfulPercent: number | null; savedMinutes: number; savedReports: number }; agents: FeedbackAgentSummary[]; truncated: boolean }

const percent = (up: number, down: number) => (up + down ? Math.round((up / (up + down)) * 1000) / 10 : null);
const emptyReasons = (): Record<FeedbackReason, number> => ({ wrong: 0, no_evidence: 0, incomplete: 0, format: 0, other: 0 });

/**
 * 평가 행 → 비서별 요약(순수). 평가 수가 많은 비서부터. 이름을 모르는(지운) 비서는 '지운 비서', 비서 없는 행은 '비서 없음'으로 묶는다.
 * 나만의 비서는 이름을 싣지 않고 '나만의 비서'로 묶는다 — 관리자 화면에 직원 개인 비서 이름이 나오지 않게
 */
export function summarizeFeedback(
  rows: { agent_id: string | null; rating: string; reason: string | null; saved_minutes?: number | null }[],
  agents: Map<string, { name: string; personal: boolean }>,
  truncated = false
): FeedbackSummary {
  const groups = new Map<string, FeedbackAgentSummary>();
  let up = 0;
  let down = 0;
  let savedMinutes = 0;
  let savedReports = 0;
  for (const row of rows) {
    if (row.rating !== 'up' && row.rating !== 'down') continue;
    const agent = row.agent_id ? agents.get(row.agent_id) : undefined;
    const key = !row.agent_id ? 'none' : !agent ? 'deleted' : agent.personal ? 'personal' : row.agent_id;
    const name = key === 'none' ? '비서 없음' : key === 'deleted' ? '지운 비서' : key === 'personal' ? '나만의 비서' : agent!.name;
    const group = groups.get(key) ?? { agentId: key === row.agent_id ? row.agent_id : null, agentName: name, up: 0, down: 0, helpfulPercent: null, reasons: emptyReasons(), savedMinutes: 0, savedReports: 0 };
    if (row.rating === 'up') {
      group.up += 1; up += 1;
      if (isSavedMinutes(row.saved_minutes)) { group.savedMinutes += row.saved_minutes; group.savedReports += 1; savedMinutes += row.saved_minutes; savedReports += 1; }
    } else { group.down += 1; down += 1; if (isFeedbackReason(row.reason)) group.reasons[row.reason] += 1; }
    groups.set(key, group);
  }
  const list = [...groups.values()].map((g) => ({ ...g, helpfulPercent: percent(g.up, g.down) }));
  list.sort((a, b) => b.up + b.down - (a.up + a.down) || a.agentName.localeCompare(b.agentName, 'ko'));
  return { total: { up, down, helpfulPercent: percent(up, down), savedMinutes, savedReports }, agents: list, truncated };
}
