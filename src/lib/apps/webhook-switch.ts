// src/lib/apps/webhook-switch.ts
// 기관 전체 자동 실행 스위치 — 외부 연동(Webhook, 0068)과 예약(0070). docs/benchmarks/allganize/APP_AUTOMATION_ADMIN.md.
//
// - 기관 전체 관리자(최상위 부서 소속 관리자)가 기관의 입력형 앱 외부 연동·예약 실행을 한 번에 끄고 켠다. 사유 5~200자, 보안 로그에 남는다.
// - 연동을 끄면 외부 호출은 차지 전에 403(`WEBHOOK_ORG_DISABLED`), 새 연동은 403. **토큰은 회수하지 않는다** — 다시 켜면 그대로 쓴다.
// - 예약을 끄면 실행기가 그 기관의 차례를 실행하지 않고 다음 차례로 넘긴다(실패로 세지 않음), 새 예약은 403. 예약 설정은 그대로다.
// - 읽지 못하면 닫는다: 외부 호출은 던져 500, 연동·예약 만들기는 503, 실행기는 그 차례를 잡지 않는다. 직원 목록의 안내만 열어 둔다(안내일 뿐이라).
import type { ActorScope } from '@/lib/agent-permissions';
import { supabaseAdmin } from '@/lib/supabaseAdmin';
import { logSecurityEvent } from '@/lib/filter';
import type { WebhookSwitchView } from './webhook-spec';

export type WebhookSwitchState = { disabled: boolean; disabledAt: string | null; reason: string | null };
/** 연동·예약 스위치는 같은 꼴이다 */
export type OrgSwitchState = WebhookSwitchState;
export type OrgSwitchView = WebhookSwitchView;
export type OrgSwitchKind = 'webhooks' | 'schedules';

const KINDS = {
  webhooks: {
    at: 'app_webhooks_disabled_at', reason: 'app_webhooks_disabled_reason', label: '외부 연동',
    disabledEvent: 'app_webhooks_org_disabled', enabledEvent: 'app_webhooks_org_enabled',
  },
  schedules: {
    at: 'app_schedules_disabled_at', reason: 'app_schedules_disabled_reason', label: '앱 예약',
    disabledEvent: 'app_schedules_org_disabled', enabledEvent: 'app_schedules_org_enabled',
  },
} as const;

function stateOf(kind: OrgSwitchKind, row: Record<string, string | null> | null): OrgSwitchState {
  const k = KINDS[kind];
  const at = row?.[k.at] ?? null;
  return { disabled: Boolean(at), disabledAt: at, reason: at ? row?.[k.reason] ?? null : null };
}

/** 기관의 스위치 — 읽지 못하면 던진다 */
export async function readOrgSwitch(kind: OrgSwitchKind, organizationId: string): Promise<OrgSwitchState> {
  const k = KINDS[kind];
  const { data, error } = await supabaseAdmin.from('organizations').select(`${k.at}, ${k.reason}`).eq('id', organizationId).maybeSingle();
  if (error) throw new Error(`organizations ${kind} switch: ${error.message}`);
  return stateOf(kind, data as Record<string, string | null> | null);
}

export const readWebhookSwitch = (organizationId: string) => readOrgSwitch('webhooks', organizationId);
export const readScheduleSwitch = (organizationId: string) => readOrgSwitch('schedules', organizationId);

/**
 * 외부 호출 앞 검사 — 쓸 수 있는(활성·안 만료) 토큰만 기관을 본다. 그 밖은 거짓(뒤의 차지가 같은 401로 거절해, 무효 토큰에 기관 상태를 알리지 않는다).
 * 읽지 못하면 던진다(호출 라우트가 500 — 닫힘)
 */
export async function tokenOrgWebhooksDisabled(tokenHash: string, nowMs: number): Promise<boolean> {
  const { data, error } = await supabaseAdmin.from('app_webhooks').select('organization:organizations(app_webhooks_disabled_at)')
    .eq('token_hash', tokenHash).eq('status', 'active').gt('expires_at', new Date(nowMs).toISOString()).maybeSingle();
  if (error) throw new Error(`app_webhooks org switch: ${error.message}`);
  if (!data) return false;
  const org = (data as { organization: { app_webhooks_disabled_at: string | null } | { app_webhooks_disabled_at: string | null }[] | null }).organization;
  const row = Array.isArray(org) ? org[0] : org;
  return Boolean(row?.app_webhooks_disabled_at);
}

export function orgSwitchView(state: OrgSwitchState, actor: ActorScope): OrgSwitchView {
  return { ...state, canChange: actor.isAdmin && actor.managesWholeOrganization };
}
export const webhookSwitchView = orgSwitchView;

export type SwitchResult = { ok: true; data: OrgSwitchView } | { ok: false; status: number; message: string };

/**
 * 끄기·켜기 — 기관 전체를 관리하는 관리자만. 조건부로 바꾸고(이미 그 상태면 바꾸지 않고 기록도 남기지 않는다) 바뀌었을 때만 보안 로그.
 * 끌 때의 사유는 저장해 관리자·직원 화면에 보이고, 켤 때의 사유는 보안 로그에만 남는다
 */
export async function setOrgSwitch(
  kind: OrgSwitchKind, admin: { scope: ActorScope; userId: string; impersonating: boolean }, enabled: boolean, reason: string, nowMs: number,
): Promise<SwitchResult> {
  const k = KINDS[kind];
  const actor = admin.scope;
  if (!actor.organizationId) return { ok: false, status: 403, message: '기관 소속을 확인할 수 없습니다.' };
  if (!actor.isAdmin || !actor.managesWholeOrganization) return { ok: false, status: 403, message: `기관 전체 ${k.label}은 기관 전체를 관리하는 관리자(최상위 부서 소속)만 끄고 켤 수 있습니다.` };
  const base = supabaseAdmin.from('organizations');
  const { data: changed, error } = enabled
    ? await base.update({ [k.at]: null, [k.reason]: null }).eq('id', actor.organizationId).not(k.at, 'is', null).select('id')
    : await base.update({ [k.at]: new Date(nowMs).toISOString(), [k.reason]: reason }).eq('id', actor.organizationId).is(k.at, null).select('id');
  if (error) return { ok: false, status: 503, message: enabled ? `${k.label}을 켜지 못했습니다.` : `${k.label}을 끄지 못했습니다.` };
  if (changed?.length) {
    await logSecurityEvent(actor.departmentId, admin.userId, enabled ? k.enabledEvent : k.disabledEvent,
      { organization_id: actor.organizationId, reason, impersonating: admin.impersonating }, 'high');
  }
  try {
    return { ok: true, data: orgSwitchView(await readOrgSwitch(kind, actor.organizationId), actor) };
  } catch {
    return { ok: false, status: 503, message: `${k.label} 설정을 다시 읽지 못했습니다.` };
  }
}

export const setWebhookSwitch = (admin: { scope: ActorScope; userId: string; impersonating: boolean }, enabled: boolean, reason: string, nowMs: number) =>
  setOrgSwitch('webhooks', admin, enabled, reason, nowMs);
