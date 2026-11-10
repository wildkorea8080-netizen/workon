// src/lib/apps/outbound/admin.ts
// 보낼 곳(0076) 관리 — 기관 전체 관리자만 보고·만들고·회수한다. 직원은 이 기관의 쓸 수 있는 보낼 곳 이름만 본다(앱 빌더에서 고르기).
// 만들기·회수·'보내기 전 확인' 바꾸기는 보안 로그(high)에 이름·주소·비밀값 앞부분만 남긴다(비밀값 원문은 만든 응답에서 한 번만 보인다).
import { supabaseAdmin } from '@/lib/supabaseAdmin';
import type { ActorScope } from '@/lib/agent-permissions';
import { logSecurityEvent } from '@/lib/filter';
import { encryptApiKey } from '@/lib/crypto';
import { checkPublicHost, generateOutboundSecret, type HostCheck } from './deliver';
import {
  OUTBOUND_MAX_ENDPOINTS, OUTBOUND_WHOLE_ORG_ONLY, parseCreateEndpoint, parseRevokeReason,
  type OutboundDeliveryView, type OutboundEndpointView, type OutboundStatus,
} from './spec';

type Fail = { ok: false; status: number; message: string };
const ENDPOINT_COLUMNS = 'id, name, url, secret_prefix, require_approval, created_at, created_by, revoked_at, revoked_reason';
/** 화면에 보이는 최근 보내기 기록 수 */
export const RECENT_DELIVERIES = 50;

export function wholeOrgAdminProblem(actor: ActorScope | null): Fail | null {
  if (!actor?.organizationId) return { ok: false, status: 403, message: '소속 기관을 확인할 수 없습니다.' };
  if (!actor.isAdmin || !actor.managesWholeOrganization) return { ok: false, status: 403, message: OUTBOUND_WHOLE_ORG_ONLY };
  return null;
}

type EndpointRow = { id: string; name: string; url: string; secret_prefix: string; require_approval: boolean; created_at: string; created_by: string | null; revoked_at: string | null; revoked_reason: string | null };
const endpointView = (r: EndpointRow, names: Map<string, string>): OutboundEndpointView => ({
  id: r.id, name: r.name, url: r.url, secretPrefix: r.secret_prefix, requireApproval: r.require_approval === true, createdAt: r.created_at,
  createdByName: r.created_by ? names.get(r.created_by) ?? '(이름 없음)' : null, revokedAt: r.revoked_at, revokedReason: r.revoked_reason,
});

export async function listOutbound(actor: ActorScope): Promise<{ ok: true; endpoints: OutboundEndpointView[]; deliveries: OutboundDeliveryView[] } | Fail> {
  const problem = wholeOrgAdminProblem(actor);
  if (problem) return problem;
  const org = actor.organizationId!;
  const [{ data: endpoints, error }, { data: deliveries, error: deliveryError }] = await Promise.all([
    supabaseAdmin.from('app_outbound_endpoints').select(ENDPOINT_COLUMNS).eq('organization_id', org).order('created_at', { ascending: false }).limit(100),
    supabaseAdmin.from('app_outbound_deliveries').select('id, endpoint_id, agent_id, status, attempts, last_status, last_error, created_at, sent_at, next_attempt_at, decided_at, decided_by')
      .eq('organization_id', org).order('created_at', { ascending: false }).limit(RECENT_DELIVERIES),
  ]);
  if (error || deliveryError) return { ok: false, status: 503, message: '보낼 곳 목록을 불러오지 못했습니다.' };
  const rows = (endpoints ?? []) as EndpointRow[];
  const sent = (deliveries ?? []) as Array<{ id: string; endpoint_id: string; agent_id: string; status: OutboundStatus; attempts: number; last_status: number | null; last_error: string | null; created_at: string; sent_at: string | null; next_attempt_at: string; decided_at: string | null; decided_by: string | null }>;
  const userIds = [...new Set([...rows.map((r) => r.created_by), ...sent.map((d) => d.decided_by)].filter((v): v is string => Boolean(v)))];
  const agentIds = [...new Set(sent.map((d) => d.agent_id))];
  const [{ data: users }, { data: agents }] = await Promise.all([
    userIds.length ? supabaseAdmin.from('users').select('id, full_name').in('id', userIds) : Promise.resolve({ data: [] }),
    agentIds.length ? supabaseAdmin.from('agents').select('id, name').eq('organization_id', org).in('id', agentIds) : Promise.resolve({ data: [] }),
  ]);
  const names = new Map(((users ?? []) as Array<{ id: string; full_name: string | null }>).map((u) => [u.id, u.full_name ?? '(이름 없음)']));
  const agentNames = new Map(((agents ?? []) as Array<{ id: string; name: string }>).map((a) => [a.id, a.name]));
  const endpointNames = new Map(rows.map((r) => [r.id, r.name]));
  return {
    ok: true,
    endpoints: rows.map((r) => endpointView(r, names)),
    deliveries: sent.map((d) => ({
      id: d.id, endpointName: endpointNames.get(d.endpoint_id) ?? '(지운 보낼 곳)', appName: agentNames.get(d.agent_id) ?? '(앱)',
      status: d.status, attempts: d.attempts, lastStatus: d.last_status, lastError: d.last_error, createdAt: d.created_at, sentAt: d.sent_at,
      nextAttemptAt: d.status === 'pending' ? d.next_attempt_at : null,
      decidedAt: d.decided_at, decidedByName: d.decided_by ? names.get(d.decided_by) ?? '(이름 없음)' : null,
    })),
  };
}

export async function createOutboundEndpoint(actor: ActorScope, raw: unknown, checkHost: (host: string) => Promise<HostCheck> = (h) => checkPublicHost(h)): Promise<{ ok: true; endpoint: OutboundEndpointView; secret: string } | Fail> {
  const problem = wholeOrgAdminProblem(actor);
  if (problem) return problem;
  const parsed = parseCreateEndpoint(raw);
  if (!parsed.ok) return { ok: false, status: 400, message: parsed.message };
  // 등록할 때 주소가 가리키는 IP도 본다(보낼 때마다 다시 본다)
  const host = await checkHost(new URL(parsed.value.url).hostname.replace(/^\[|\]$/g, ''));
  if (!host.ok) return { ok: false, status: 400, message: host.message };
  const { count, error: countError } = await supabaseAdmin.from('app_outbound_endpoints').select('id', { count: 'exact', head: true })
    .eq('organization_id', actor.organizationId!).is('revoked_at', null);
  if (countError) return { ok: false, status: 503, message: '보낼 곳을 만들지 못했습니다. 잠시 뒤 다시 시도해 주세요.' };
  if ((count ?? 0) >= OUTBOUND_MAX_ENDPOINTS) return { ok: false, status: 409, message: `쓸 수 있는 보낼 곳은 기관에 ${OUTBOUND_MAX_ENDPOINTS}개까지입니다. 쓰지 않는 곳을 먼저 회수해 주세요.` };
  const { secret, prefix } = generateOutboundSecret();
  const { data, error } = await supabaseAdmin.from('app_outbound_endpoints').insert({
    organization_id: actor.organizationId, name: parsed.value.name, url: parsed.value.url, secret_encrypted: encryptApiKey(secret), secret_prefix: prefix, created_by: actor.userId,
    require_approval: parsed.value.requireApproval,
  }).select(ENDPOINT_COLUMNS).single();
  if (error || !data) return { ok: false, status: 503, message: '보낼 곳을 만들지 못했습니다. 잠시 뒤 다시 시도해 주세요.' };
  await logSecurityEvent(actor.departmentId, actor.userId, 'app_outbound_endpoint_created', { endpoint_id: data.id, name: parsed.value.name, url: parsed.value.url, secret_prefix: prefix, require_approval: parsed.value.requireApproval }, 'high');
  return { ok: true, endpoint: endpointView(data as EndpointRow, new Map()), secret };
}

export async function revokeOutboundEndpoint(actor: ActorScope, id: string, rawReason: unknown, nowMs = Date.now()): Promise<{ ok: true } | Fail> {
  const problem = wholeOrgAdminProblem(actor);
  if (problem) return problem;
  if (!/^[0-9a-f-]{36}$/i.test(id)) return { ok: false, status: 404, message: '보낼 곳을 찾을 수 없습니다.' };
  const reason = parseRevokeReason(rawReason);
  if (!reason.ok) return { ok: false, status: 400, message: reason.message };
  const { data, error } = await supabaseAdmin.from('app_outbound_endpoints')
    .update({ revoked_at: new Date(nowMs).toISOString(), revoked_by: actor.userId, revoked_reason: reason.reason })
    .eq('id', id).eq('organization_id', actor.organizationId!).is('revoked_at', null).select('id, name, url');
  if (error) return { ok: false, status: 503, message: '보낼 곳을 회수하지 못했습니다. 잠시 뒤 다시 시도해 주세요.' };
  if (!data?.length) return { ok: false, status: 404, message: '보낼 곳을 찾을 수 없거나 이미 회수됐습니다.' };
  // 보내지 않은 기록(확인 기다림 포함)은 그만둔다(보낼 때도 다시 보지만, 화면에 바로 보이게)
  await supabaseAdmin.from('app_outbound_deliveries').update({ status: 'gave_up', claimed_at: null, last_error: '보낼 곳이 회수됐습니다.' })
    .eq('endpoint_id', id).in('status', ['pending', 'awaiting_approval']);
  await logSecurityEvent(actor.departmentId, actor.userId, 'app_outbound_endpoint_revoked', { endpoint_id: id, name: data[0].name, url: data[0].url, reason: reason.reason }, 'high');
  return { ok: true };
}

/**
 * '보내기 전 확인' 켜고 끄기(0078) — 켜면 그 뒤 넣는 기록부터 직원 확인을 기다린다. 꺼도 이미 확인을 기다리는 기록은 그대로(직원이 정함).
 * 요청 몸 `{ require_approval: boolean }`
 */
export async function setEndpointApproval(actor: ActorScope, id: string, raw: unknown): Promise<{ ok: true; endpoint: OutboundEndpointView } | Fail> {
  const problem = wholeOrgAdminProblem(actor);
  if (problem) return problem;
  if (!/^[0-9a-f-]{36}$/i.test(id)) return { ok: false, status: 404, message: '보낼 곳을 찾을 수 없습니다.' };
  const body = raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw as Record<string, unknown>) : null;
  if (typeof body?.require_approval !== 'boolean') return { ok: false, status: 400, message: '보내기 전 확인을 켤지 끌지 정해 주세요.' };
  const requireApproval = body.require_approval;
  const { data, error } = await supabaseAdmin.from('app_outbound_endpoints').update({ require_approval: requireApproval })
    .eq('id', id).eq('organization_id', actor.organizationId!).is('revoked_at', null).select(ENDPOINT_COLUMNS);
  if (error) return { ok: false, status: 503, message: '보낼 곳을 바꾸지 못했습니다. 잠시 뒤 다시 시도해 주세요.' };
  if (!data?.length) return { ok: false, status: 404, message: '보낼 곳을 찾을 수 없거나 이미 회수됐습니다.' };
  const row = data[0] as EndpointRow;
  await logSecurityEvent(actor.departmentId, actor.userId, 'app_outbound_endpoint_updated', { endpoint_id: id, name: row.name, url: row.url, require_approval: requireApproval }, 'high');
  return { ok: true, endpoint: endpointView(row, new Map()) };
}

/** 직원이 앱에 고를 수 있는 보낼 곳 — 이 기관의 회수되지 않은 곳, 이름과 보내기 전 확인 여부만(주소·비밀값 없음) */
export async function listUsableEndpoints(organizationId: string): Promise<Array<{ id: string; name: string; requireApproval: boolean }> | null> {
  const { data, error } = await supabaseAdmin.from('app_outbound_endpoints').select('id, name, require_approval')
    .eq('organization_id', organizationId).is('revoked_at', null).order('name', { ascending: true }).limit(100);
  if (error) return null;
  return ((data ?? []) as Array<{ id: string; name: string; require_approval: boolean }>).map((r) => ({ id: r.id, name: r.name, requireApproval: r.require_approval === true }));
}
