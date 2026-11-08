import type { ActorScope } from '@/lib/agent-permissions';
import { supabaseAdmin } from '@/lib/supabaseAdmin';
import { logSecurityEvent } from '@/lib/filter';
import { readScheduleHealth } from '@/lib/apps/schedule-health';
import { readWebhookSwitch, webhookSwitchView } from '@/lib/apps/webhook-switch';
import { notifyAutomationOwner } from '@/lib/apps/automation-notice';
import {
  ADMIN_AUTOMATION_LIMIT, ADMIN_UNLOCKED_REASON, adminPausedReason, adminRevokedReason, adminScheduleView, adminWebhookView,
  type AdminAutomationList, type AdminScheduleRow, type AdminScheduleView, type AdminWebhookRow, type AdminWebhookView,
} from '@/lib/apps/automation-admin-spec';

export * from '@/lib/apps/automation-admin-spec';

/**
 * 앱 예약·연동 관리자 통제(0050, docs/benchmarks/allganize/APP_AUTOMATION_ADMIN.md).
 *
 * 기관 관리자는 **관리 범위 부서** 직원의 예약·연동을 본다 — 무엇이(앱·연동 이름) 누구 이름으로(직원·부서) 언제까지·몇 번 도는지.
 * **입력값·결과·대화·실패 원문·토큰은 보지 않는다**(직원 작업은 관리자도 열람하지 않는다는 원칙). 개인 앱은 이름도 가린다(앱 실행 현황과 같음).
 * 관리자가 할 수 있는 것: 연동 회수(되돌릴 수 없음), 예약 멈춤(직원이 다시 켜지 못하게 잠금)과 잠금 풀기. 모두 사유 5자 이상을 받고 보안 로그에 남긴다.
 */

const WEBHOOK_SELECT = 'id, name, token_prefix, status, expires_at, revoked_at, revoked_reason, last_used_at, use_count, last_status, created_at, department_id, agent:agents(name, tier), owner:users(full_name, deleted_at)';
const SCHEDULE_SELECT = 'id, frequency, weekday, month_day, run_hour, run_minute, status, paused_reason, admin_paused_at, next_run_at, last_run_at, last_status, consecutive_failures, run_count, created_at, department_id, agent:agents(name, tier), owner:users(full_name, deleted_at)';

export type AdminResult<T> = { ok: true; data: T } | { ok: false; status: number; message: string };

/** 관리 범위가 없으면 아무것도 보이지 않는다(실패가 범위를 넓히지 않게) */
function scoped(actor: ActorScope): actor is ActorScope & { organizationId: string } {
  return Boolean(actor.organizationId) && actor.managedDepartmentIds.length > 0;
}

export async function listAdminAutomations(actor: ActorScope, nowMs: number): Promise<AdminResult<AdminAutomationList>> {
  if (!scoped(actor)) return { ok: false, status: 403, message: '관리 범위를 확인할 수 없습니다.' };
  // 실행기 상태는 곁들이는 정보 — 읽지 못해도 목록은 보인다(null)
  const runnerPromise = readScheduleHealth(nowMs, { organizationId: actor.organizationId, departmentIds: actor.managedDepartmentIds })
    .then((h) => ({ alive: h.runnerAlive, lastRunAt: h.runnerLastRunAt, overdueCount: h.overdueCount, stuckClaimCount: h.stuckClaimCount, problems: h.problems }))
    .catch(() => null);
  const switchPromise = readWebhookSwitch(actor.organizationId).then((s) => webhookSwitchView(s, actor)).catch(() => null);
  const [webhooks, schedules, departments] = await Promise.all([
    supabaseAdmin.from('app_webhooks').select(WEBHOOK_SELECT).eq('organization_id', actor.organizationId)
      .in('department_id', actor.managedDepartmentIds).order('created_at', { ascending: false }).limit(ADMIN_AUTOMATION_LIMIT + 1),
    supabaseAdmin.from('app_schedules').select(SCHEDULE_SELECT).eq('organization_id', actor.organizationId)
      .in('department_id', actor.managedDepartmentIds).order('created_at', { ascending: false }).limit(ADMIN_AUTOMATION_LIMIT + 1),
    supabaseAdmin.from('departments').select('id, name').eq('organization_id', actor.organizationId).in('id', actor.managedDepartmentIds),
  ]);
  if (webhooks.error || schedules.error || departments.error) return { ok: false, status: 503, message: '앱 예약·연동을 불러오지 못했습니다.' };
  const deptName = new Map(((departments.data ?? []) as Array<{ id: string; name: string }>).map((d) => [d.id, d.name]));
  const hookRows = (webhooks.data ?? []) as unknown as AdminWebhookRow[];
  const scheduleRows = (schedules.data ?? []) as unknown as AdminScheduleRow[];
  return {
    ok: true,
    data: {
      webhooks: hookRows.slice(0, ADMIN_AUTOMATION_LIMIT).map((r) => adminWebhookView(r, deptName.get(r.department_id) ?? null, nowMs)),
      schedules: scheduleRows.slice(0, ADMIN_AUTOMATION_LIMIT).map((r) => adminScheduleView(r, deptName.get(r.department_id) ?? null, nowMs)),
      truncated: hookRows.length > ADMIN_AUTOMATION_LIMIT || scheduleRows.length > ADMIN_AUTOMATION_LIMIT,
      runner: await runnerPromise,
      webhookSwitch: await switchPromise,
    },
  };
}

export type AdminActor = { scope: ActorScope; userId: string; impersonating: boolean };

/** 범위 안의 행인지 — 기관과 관리 부서를 함께 건다(부서 id만 보면 기관이 어긋난 행이 걸린다) */
async function findScoped(table: 'app_webhooks' | 'app_schedules', id: string, actor: ActorScope & { organizationId: string }, columns: string) {
  return supabaseAdmin.from(table).select(columns).eq('id', id).eq('organization_id', actor.organizationId)
    .in('department_id', actor.managedDepartmentIds).maybeSingle();
}

async function audit(admin: AdminActor, event: 'app_webhook_revoked' | 'app_schedule_paused' | 'app_schedule_unlocked', details: Record<string, unknown>) {
  await logSecurityEvent(admin.scope.departmentId, admin.userId, event, { ...details, impersonating: admin.impersonating }, 'medium');
}

/** 연동 회수 — 활성 연동만 바꾼다(이미 회수된 것은 그대로 돌려준다). 되돌릴 수 없다 */
export async function revokeWebhookByAdmin(admin: AdminActor, id: string, reason: string, nowMs: number): Promise<AdminResult<AdminWebhookView>> {
  const actor = admin.scope;
  if (!scoped(actor)) return { ok: false, status: 403, message: '관리 범위를 확인할 수 없습니다.' };
  const found = await findScoped('app_webhooks', id, actor, 'id, user_id, agent_id, status');
  if (found.error) return { ok: false, status: 503, message: '연동을 불러오지 못했습니다.' };
  const target = found.data as { id: string; user_id: string; agent_id: string; status: string } | null;
  if (!target) return { ok: false, status: 404, message: '관리 범위에서 연동을 찾을 수 없습니다.' };
  const now = new Date(nowMs).toISOString();
  if (target.status === 'active') {
    const { data: changed, error } = await supabaseAdmin.from('app_webhooks')
      .update({ status: 'revoked', revoked_at: now, revoked_reason: adminRevokedReason(reason), updated_at: now })
      .eq('id', id).eq('organization_id', actor.organizationId).eq('status', 'active').select('id');
    if (error) return { ok: false, status: 503, message: '연동을 회수하지 못했습니다.' };
    if (changed?.length) {
      await audit(admin, 'app_webhook_revoked', { webhook_id: id, owner_user_id: target.user_id, agent_id: target.agent_id, reason });
      await notifyAutomationOwner({ kind: 'webhook_revoked', organizationId: actor.organizationId, userId: target.user_id, agentId: target.agent_id, targetId: id, reason, at: new Date(nowMs) });
    }
  }
  return readWebhook(actor, id, nowMs);
}

async function readWebhook(actor: ActorScope & { organizationId: string }, id: string, nowMs: number): Promise<AdminResult<AdminWebhookView>> {
  const { data, error } = await findScoped('app_webhooks', id, actor, WEBHOOK_SELECT);
  if (error || !data) return { ok: false, status: 503, message: '연동을 불러오지 못했습니다.' };
  const row = data as unknown as AdminWebhookRow;
  return { ok: true, data: adminWebhookView(row, await departmentName(row.department_id, actor.organizationId), nowMs) };
}

async function readSchedule(actor: ActorScope & { organizationId: string }, id: string): Promise<AdminResult<AdminScheduleView>> {
  const { data, error } = await findScoped('app_schedules', id, actor, SCHEDULE_SELECT);
  if (error || !data) return { ok: false, status: 503, message: '예약을 불러오지 못했습니다.' };
  const row = data as unknown as AdminScheduleRow;
  return { ok: true, data: adminScheduleView(row, await departmentName(row.department_id, actor.organizationId), Date.now()) };
}

async function departmentName(id: string, organizationId: string): Promise<string | null> {
  const { data } = await supabaseAdmin.from('departments').select('name').eq('id', id).eq('organization_id', organizationId).maybeSingle();
  return (data as { name: string } | null)?.name ?? null;
}

/**
 * 예약 멈춤 — 켜져 있든 직원이 멈췄든 관리자 잠금을 건다(직원이 다시 켜지 못한다). 이미 잠긴 예약은 그대로.
 * 실행 중인 차례는 끝까지 간다(차지를 뺏지 않는다) — 다음 차례부터 돌지 않는다.
 */
export async function pauseScheduleByAdmin(admin: AdminActor, id: string, reason: string, nowMs: number): Promise<AdminResult<AdminScheduleView>> {
  const actor = admin.scope;
  if (!scoped(actor)) return { ok: false, status: 403, message: '관리 범위를 확인할 수 없습니다.' };
  const found = await findScoped('app_schedules', id, actor, 'id, user_id, agent_id, admin_paused_at');
  if (found.error) return { ok: false, status: 503, message: '예약을 불러오지 못했습니다.' };
  const target = found.data as { id: string; user_id: string; agent_id: string; admin_paused_at: string | null } | null;
  if (!target) return { ok: false, status: 404, message: '관리 범위에서 예약을 찾을 수 없습니다.' };
  if (target.admin_paused_at === null) {
    const now = new Date(nowMs).toISOString();
    const { data: changed, error } = await supabaseAdmin.from('app_schedules')
      .update({ status: 'paused', paused_reason: adminPausedReason(reason), admin_paused_at: now, updated_at: now })
      .eq('id', id).eq('organization_id', actor.organizationId).is('admin_paused_at', null).select('id');
    if (error) return { ok: false, status: 503, message: '예약을 멈추지 못했습니다.' };
    if (changed?.length) {
      await audit(admin, 'app_schedule_paused', { schedule_id: id, owner_user_id: target.user_id, agent_id: target.agent_id, reason });
      await notifyAutomationOwner({ kind: 'schedule_paused', organizationId: actor.organizationId, userId: target.user_id, agentId: target.agent_id, targetId: id, reason, at: new Date(nowMs) });
    }
  }
  return readSchedule(actor, id);
}

/** 잠금 풀기 — 예약은 멈춘 채로 두고 직원이 다시 켤 수 있게만 한다(관리자가 남의 예약을 대신 켜지 않는다) */
export async function unlockScheduleByAdmin(admin: AdminActor, id: string, reason: string, nowMs: number): Promise<AdminResult<AdminScheduleView>> {
  const actor = admin.scope;
  if (!scoped(actor)) return { ok: false, status: 403, message: '관리 범위를 확인할 수 없습니다.' };
  const found = await findScoped('app_schedules', id, actor, 'id, user_id, agent_id, admin_paused_at');
  if (found.error) return { ok: false, status: 503, message: '예약을 불러오지 못했습니다.' };
  const target = found.data as { id: string; user_id: string; agent_id: string; admin_paused_at: string | null } | null;
  if (!target) return { ok: false, status: 404, message: '관리 범위에서 예약을 찾을 수 없습니다.' };
  if (target.admin_paused_at !== null) {
    const now = new Date(nowMs).toISOString();
    const { data: changed, error } = await supabaseAdmin.from('app_schedules')
      .update({ admin_paused_at: null, paused_reason: ADMIN_UNLOCKED_REASON, updated_at: now })
      .eq('id', id).eq('organization_id', actor.organizationId).not('admin_paused_at', 'is', null).select('id');
    if (error) return { ok: false, status: 503, message: '잠금을 풀지 못했습니다.' };
    if (changed?.length) {
      await audit(admin, 'app_schedule_unlocked', { schedule_id: id, owner_user_id: target.user_id, agent_id: target.agent_id, reason });
      await notifyAutomationOwner({ kind: 'schedule_unlocked', organizationId: actor.organizationId, userId: target.user_id, agentId: target.agent_id, targetId: id, reason, at: new Date(nowMs) });
    }
  }
  return readSchedule(actor, id);
}
