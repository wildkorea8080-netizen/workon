// src/lib/message-feedback.ts
// 답변 평가(2026-11-05, 0064) — 직원이 AI 답변에 '도움됨 / 아쉬움'(+ 정해 둔 이유 하나)을 남기고, 기관 관리자가 비서별로 모아 본다.
// 대화 주인만 평가한다(관리자도 남의 답변에 못 남김). 관리자 요약에는 숫자·비서 이름만 — 질문·답변 원문·직원은 싣지 않는다.
import { supabaseAdmin } from '@/lib/supabaseAdmin';
import { pagedRows } from '@/lib/paged-select';
import { summarizeFeedback, type FeedbackSummary, type MessageFeedback } from '@/lib/message-feedback-spec';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const NOT_FOUND = '평가할 답변을 찾을 수 없습니다.';
const RETRY = '평가를 저장하지 못했습니다. 잠시 뒤 다시 시도해 주세요.';
/** 요약 기간 상한 — 1년 */
export const FEEDBACK_MAX_DAYS = 366;

type Failure = { ok: false; status: number; message: string };
type Actor = { userId: string; organizationId: string };

/**
 * 평가 저장·지우기. 답변(assistant) 메시지이고 **그 대화의 주인**일 때만. `rating: null`이면 지운다.
 * 같은 답변을 다시 누르면 덮어쓴다(답변 하나에 평가 하나)
 */
export async function saveMessageFeedback(
  actor: Actor,
  messageId: string,
  input: { rating: null } | MessageFeedback
): Promise<{ ok: true; feedback: MessageFeedback | null } | Failure> {
  if (!UUID.test(messageId)) return { ok: false, status: 404, message: NOT_FOUND };
  const id = messageId.toLowerCase();
  const { data: message, error } = await supabaseAdmin.from('messages').select('id, role, conversation_id, agent_version').eq('id', id).maybeSingle();
  if (error) return { ok: false, status: 503, message: RETRY };
  const msg = message as { role?: string; conversation_id?: string; agent_version?: number | null } | null;
  if (!msg || msg.role !== 'assistant' || typeof msg.conversation_id !== 'string') return { ok: false, status: 404, message: NOT_FOUND };
  const { data: conversation, error: convError } = await supabaseAdmin
    .from('conversations')
    .select('id, agent_id, department_id')
    .eq('id', msg.conversation_id)
    .eq('user_id', actor.userId)
    .maybeSingle();
  if (convError) return { ok: false, status: 503, message: RETRY };
  const conv = conversation as { id: string; agent_id: string | null; department_id: string } | null;
  if (!conv) return { ok: false, status: 404, message: NOT_FOUND };

  if (input.rating === null) {
    const { error: deleteError } = await supabaseAdmin.from('message_feedback').delete().eq('message_id', id).eq('user_id', actor.userId);
    if (deleteError) return { ok: false, status: 503, message: RETRY };
    return { ok: true, feedback: null };
  }
  const { error: saveError } = await supabaseAdmin.from('message_feedback').upsert(
    {
      message_id: id,
      conversation_id: conv.id,
      user_id: actor.userId,
      agent_id: conv.agent_id,
      department_id: conv.department_id,
      organization_id: actor.organizationId,
      agent_version: typeof msg.agent_version === 'number' ? msg.agent_version : null,
      rating: input.rating,
      reason: input.reason,
      updated_at: new Date().toISOString(),
    },
    { onConflict: 'message_id' }
  );
  if (saveError) return { ok: false, status: 503, message: RETRY };
  return { ok: true, feedback: { rating: input.rating, reason: input.reason } };
}

/** 이 대화에서 내가 남긴 평가(답변 id → 평가). 못 읽으면 빈 값 — 대화 화면은 평가 없이 돈다 */
export async function loadConversationFeedback(userId: string, conversationId: string): Promise<Record<string, MessageFeedback>> {
  try {
    const { data, error } = await supabaseAdmin.from('message_feedback').select('message_id, rating, reason').eq('conversation_id', conversationId).eq('user_id', userId);
    if (error) return {};
    const out: Record<string, MessageFeedback> = {};
    for (const row of (data ?? []) as { message_id: string; rating: MessageFeedback['rating']; reason: MessageFeedback['reason'] }[]) out[row.message_id] = { rating: row.rating, reason: row.reason ?? null };
    return out;
  } catch {
    return {};
  }
}

/** YYYY-MM-DD(KST) 두 날짜 → 기간(끝 날 포함). 꼴이 틀리거나 뒤집혔거나 1년을 넘으면 null */
export function feedbackPeriod(from: string | null, to: string | null, now = new Date()): { from: string; to: string; fromIso: string; toIso: string } | null {
  const today = new Date(now.getTime() + 9 * 3600_000).toISOString().slice(0, 10);
  const end = to ?? today;
  const start = from ?? new Date(Date.parse(`${end}T00:00:00Z`) - 29 * 86400_000).toISOString().slice(0, 10);
  const valid = (d: string) => /^\d{4}-\d{2}-\d{2}$/.test(d) && new Date(`${d}T00:00:00Z`).toISOString().slice(0, 10) === d;
  if (!valid(start) || !valid(end) || start > end) return null;
  const days = (Date.parse(`${end}T00:00:00Z`) - Date.parse(`${start}T00:00:00Z`)) / 86400_000 + 1;
  if (days > FEEDBACK_MAX_DAYS) return null;
  const next = new Date(Date.parse(`${end}T00:00:00Z`) + 86400_000).toISOString().slice(0, 10);
  return { from: start, to: end, fromIso: `${start}T00:00:00+09:00`, toIso: `${next}T00:00:00+09:00` };
}

/**
 * 관리 범위의 평가를 비서별로 — `departmentIds`가 null이면 기관 전체(최상위 관리자). 평가를 바꾼 때(updated_at) 기준으로 기간을 본다.
 * 행은 쪽마다 끝까지 읽는다(1,000행 상한에 덜 세지 않게)
 */
export async function loadFeedbackSummary(
  scope: { organizationId: string; departmentIds: string[] | null },
  period: { fromIso: string; toIso: string }
): Promise<FeedbackSummary> {
  const rows = await pagedRows<{ message_id: string; agent_id: string | null; rating: string; reason: string | null }>((a, b, withCount) => {
    let q = supabaseAdmin
      .from('message_feedback')
      .select('message_id, agent_id, rating, reason', withCount ? { count: 'exact' } : undefined)
      .eq('organization_id', scope.organizationId)
      .gte('updated_at', period.fromIso)
      .lt('updated_at', period.toIso);
    if (scope.departmentIds) q = q.in('department_id', scope.departmentIds);
    return q.order('message_id').range(a, b);
  });
  if (rows.error) throw new Error(`message_feedback: ${rows.error.message}`);
  const ids = [...new Set(rows.data.map((r) => r.agent_id).filter((v): v is string => typeof v === 'string'))];
  const agents = new Map<string, { name: string; personal: boolean }>();
  for (let i = 0; i < ids.length; i += 200) {
    const { data, error } = await supabaseAdmin.from('agents').select('id, name, tier').eq('organization_id', scope.organizationId).in('id', ids.slice(i, i + 200));
    if (error) throw new Error(`agents: ${error.message}`);
    for (const a of (data ?? []) as { id: string; name: string; tier: string }[]) agents.set(a.id, { name: a.name, personal: a.tier === 'personal' });
  }
  return summarizeFeedback(rows.data, agents, rows.truncated);
}
