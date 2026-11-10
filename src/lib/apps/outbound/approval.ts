// src/lib/apps/outbound/approval.ts
// 보내기 전 사람 확인(0078) — 보낼 곳이 '보내기 전 확인'이면 실행을 마친 결과를 awaiting_approval로 넣고(`enqueueOutbound`),
// **그 결과를 실행한 직원만** 결과 글을 보고 '보내기'(→ pending, 다음 실행기 차례에 보냄) 또는 '보내지 않기'(→ rejected)를 정한다.
// 관리자도 남의 결과를 대신 정하지 않는다(결과 글을 보는 것도 실행한 직원뿐). 7일 안에 정하지 않으면 실행기가 그만둠으로 바꾼다.
// 정할 때 보낼 곳이 아직 쓸 수 있는지 다시 보고, 조건부 갱신(상태·주인·기한)으로 두 번 누름·다른 탭과 겹쳐도 한 번만 바뀐다.
// 정한 일은 보안 로그(low)에 기록 id·보낼 곳·앱만 남긴다(결과 글 없음).
import { supabaseAdmin } from '@/lib/supabaseAdmin';
import { logSecurityEvent } from '@/lib/filter';
import {
  OUTBOUND_APPROVAL_ENDPOINT_GONE, OUTBOUND_APPROVAL_EXPIRED, OUTBOUND_APPROVAL_MS, OUTBOUND_PREVIEW_CHARS, OUTBOUND_STATUS_LABELS,
  approvalExpiresAt, type OutboundApprovalView, type OutboundDecision, type OutboundStatus,
} from './spec';

type Fail = { ok: false; status: number; message: string };
export interface ApprovalActor { userId: string; organizationId: string; departmentId: string }
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** 화면에 한 번에 보이는 확인할 결과 수 */
export const APPROVAL_LIST_LIMIT = 50;
export const APPROVAL_NOT_FOUND = '확인할 결과를 찾을 수 없습니다.';
export const APPROVAL_CHANGED = '그 사이 상태가 바뀌었습니다. 목록을 다시 열어 주세요.';
export const APPROVAL_REJECTED_NOTE = '직원이 보내지 않기로 했습니다.';

export interface DeliveryRow { id: string; organization_id: string; user_id: string | null; endpoint_id: string; agent_id: string; status: OutboundStatus; created_at: string }
export interface DecideDeps {
  now(): number;
  load(id: string): Promise<DeliveryRow | null>;
  /** 보낼 곳이 이 기관의 회수되지 않은 곳이면 이름, 아니면 null */
  activeEndpoint(endpointId: string, organizationId: string): Promise<{ name: string } | null>;
  /** 확인 기다림·이 직원·기한 안일 때만 바꾼다 — 바꿨으면 참 */
  update(row: DeliveryRow, patch: Record<string, unknown>, notBeforeIso: string): Promise<boolean>;
  log(actor: ApprovalActor, decision: OutboundDecision, details: Record<string, unknown>): Promise<void>;
}

/** 이 직원이 실행한 결과를 보낼지 정한다 */
export async function decideApproval(actor: ApprovalActor, id: string, decision: OutboundDecision, deps: DecideDeps = decideDeps()): Promise<{ ok: true; status: OutboundStatus } | Fail> {
  if (!UUID.test(id)) return { ok: false, status: 404, message: APPROVAL_NOT_FOUND };
  let row: DeliveryRow | null;
  try { row = await deps.load(id); } catch { return { ok: false, status: 503, message: '결과를 불러오지 못했습니다. 잠시 뒤 다시 시도해 주세요.' }; }
  // 남의 결과·다른 기관은 있는지도 알리지 않는다
  if (!row || row.user_id !== actor.userId || row.organization_id !== actor.organizationId) return { ok: false, status: 404, message: APPROVAL_NOT_FOUND };
  if (row.status !== 'awaiting_approval') return { ok: false, status: 409, message: `이미 정한 결과입니다(${OUTBOUND_STATUS_LABELS[row.status] ?? row.status}).` };
  const now = deps.now();
  if (now > approvalExpiresAt(row.created_at)) return { ok: false, status: 409, message: OUTBOUND_APPROVAL_EXPIRED };
  let endpoint: { name: string } | null = null;
  if (decision === 'approve') {
    try { endpoint = await deps.activeEndpoint(row.endpoint_id, row.organization_id); } catch { return { ok: false, status: 503, message: '보낼 곳을 확인하지 못했습니다. 잠시 뒤 다시 시도해 주세요.' }; }
    if (!endpoint) return { ok: false, status: 409, message: OUTBOUND_APPROVAL_ENDPOINT_GONE };
  }
  const nowIso = new Date(now).toISOString();
  const patch = decision === 'approve'
    ? { status: 'pending', next_attempt_at: nowIso, decided_by: actor.userId, decided_at: nowIso }
    : { status: 'rejected', decided_by: actor.userId, decided_at: nowIso, last_error: APPROVAL_REJECTED_NOTE };
  let changed: boolean;
  try { changed = await deps.update(row, patch, new Date(now - OUTBOUND_APPROVAL_MS).toISOString()); } catch { return { ok: false, status: 503, message: '정하지 못했습니다. 잠시 뒤 다시 시도해 주세요.' }; }
  if (!changed) return { ok: false, status: 409, message: APPROVAL_CHANGED };
  try { await deps.log(actor, decision, { delivery_id: row.id, endpoint_id: row.endpoint_id, endpoint_name: endpoint?.name ?? null, agent_id: row.agent_id }); } catch { /* 기록 실패는 결과를 바꾸지 않는다 */ }
  return { ok: true, status: decision === 'approve' ? 'pending' : 'rejected' };
}

export function decideDeps(): DecideDeps {
  return {
    now: () => Date.now(),
    async load(id) {
      const { data, error } = await supabaseAdmin.from('app_outbound_deliveries').select('id, organization_id, user_id, endpoint_id, agent_id, status, created_at').eq('id', id).maybeSingle();
      if (error) throw error;
      return (data ?? null) as DeliveryRow | null;
    },
    async activeEndpoint(endpointId, organizationId) {
      const { data, error } = await supabaseAdmin.from('app_outbound_endpoints').select('name').eq('id', endpointId).eq('organization_id', organizationId).is('revoked_at', null).maybeSingle();
      if (error) throw error;
      return (data ?? null) as { name: string } | null;
    },
    async update(row, patch, notBeforeIso) {
      const { data, error } = await supabaseAdmin.from('app_outbound_deliveries').update(patch)
        .eq('id', row.id).eq('user_id', row.user_id!).eq('status', 'awaiting_approval').gte('created_at', notBeforeIso).select('id');
      if (error) throw error;
      return Boolean(data?.length);
    },
    async log(actor, decision, details) {
      await logSecurityEvent(actor.departmentId, actor.userId, decision === 'approve' ? 'app_outbound_result_approved' : 'app_outbound_result_rejected', details, 'low');
    },
  };
}

/** 이 직원이 확인할 결과 — 기한 안의 확인 기다림만, 앱으로 거를 수 있다. 결과 글은 앞부분만(전체는 대화에서) */
export async function listMyApprovals(actor: ApprovalActor, agentId: string | null, nowMs = Date.now()): Promise<{ ok: true; items: OutboundApprovalView[] } | Fail> {
  if (agentId !== null && !UUID.test(agentId)) return { ok: false, status: 400, message: '앱을 확인해 주세요.' };
  let q = supabaseAdmin.from('app_outbound_deliveries').select('id, agent_id, endpoint_id, message_id, created_at')
    .eq('user_id', actor.userId).eq('organization_id', actor.organizationId).eq('status', 'awaiting_approval')
    .gte('created_at', new Date(nowMs - OUTBOUND_APPROVAL_MS).toISOString());
  if (agentId) q = q.eq('agent_id', agentId);
  const { data, error } = await q.order('created_at', { ascending: false }).limit(APPROVAL_LIST_LIMIT);
  if (error) return { ok: false, status: 503, message: '확인할 결과를 불러오지 못했습니다.' };
  const rows = (data ?? []) as Array<{ id: string; agent_id: string; endpoint_id: string; message_id: string; created_at: string }>;
  if (!rows.length) return { ok: true, items: [] };
  const [messages, endpoints, agents] = await Promise.all([
    // 이 직원의 대화에 있는 답변만(결과 글을 남에게 보이지 않게)
    supabaseAdmin.from('messages').select('id, content, conversation_id, conversation:conversations!inner(user_id)')
      .in('id', [...new Set(rows.map((r) => r.message_id))]).eq('conversation.user_id', actor.userId),
    supabaseAdmin.from('app_outbound_endpoints').select('id, name').eq('organization_id', actor.organizationId).in('id', [...new Set(rows.map((r) => r.endpoint_id))]),
    supabaseAdmin.from('agents').select('id, name').eq('organization_id', actor.organizationId).in('id', [...new Set(rows.map((r) => r.agent_id))]),
  ]);
  if (messages.error || endpoints.error || agents.error) return { ok: false, status: 503, message: '확인할 결과를 불러오지 못했습니다.' };
  const byMessage = new Map(((messages.data ?? []) as unknown as Array<{ id: string; content: string; conversation_id: string }>).map((m) => [m.id, m]));
  const endpointNames = new Map(((endpoints.data ?? []) as Array<{ id: string; name: string }>).map((e) => [e.id, e.name]));
  const agentNames = new Map(((agents.data ?? []) as Array<{ id: string; name: string }>).map((a) => [a.id, a.name]));
  return {
    ok: true,
    items: rows.map((r) => {
      const message = byMessage.get(r.message_id);
      const text = message?.content ?? '';
      return {
        id: r.id, agentId: r.agent_id, appName: agentNames.get(r.agent_id) ?? '(앱)', endpointName: endpointNames.get(r.endpoint_id) ?? '(보낼 곳)',
        conversationId: message?.conversation_id ?? null, createdAt: r.created_at, expiresAt: new Date(approvalExpiresAt(r.created_at)).toISOString(),
        preview: text.slice(0, OUTBOUND_PREVIEW_CHARS), truncated: text.length > OUTBOUND_PREVIEW_CHARS,
      };
    }),
  };
}
