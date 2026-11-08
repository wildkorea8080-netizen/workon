// src/lib/apps/webhook-switch.ts
// 기관 전체 외부 연동(Webhook) 스위치(0068, docs/benchmarks/allganize/APP_AUTOMATION_ADMIN.md).
//
// - 기관 전체 관리자(최상위 부서 소속 관리자)가 기관의 입력형 앱 외부 연동을 한 번에 끄고 켠다. 사유 5~200자, 보안 로그에 남는다.
// - 끄면 외부 호출은 차지 전에 403(`WEBHOOK_ORG_DISABLED`), 새 연동은 403. **토큰은 회수하지 않는다** — 다시 켜면 그대로 쓴다.
//   하나씩 영구히 막을 때는 0050의 '회수'를 쓴다.
// - 읽지 못하면 닫는다: 외부 호출은 던져 500, 연동 만들기는 503. 직원 목록의 안내만 열어 둔다(안내일 뿐이라).
import type { ActorScope } from '@/lib/agent-permissions';
import { supabaseAdmin } from '@/lib/supabaseAdmin';
import { logSecurityEvent } from '@/lib/filter';
import type { WebhookSwitchView } from './webhook-spec';

export type WebhookSwitchState = { disabled: boolean; disabledAt: string | null; reason: string | null };
type OrgRow = { app_webhooks_disabled_at: string | null; app_webhooks_disabled_reason: string | null };

const stateOf = (row: OrgRow | null): WebhookSwitchState => ({
  disabled: Boolean(row?.app_webhooks_disabled_at),
  disabledAt: row?.app_webhooks_disabled_at ?? null,
  reason: row?.app_webhooks_disabled_at ? row.app_webhooks_disabled_reason ?? null : null,
});

/** 기관의 스위치 — 읽지 못하면 던진다 */
export async function readWebhookSwitch(organizationId: string): Promise<WebhookSwitchState> {
  const { data, error } = await supabaseAdmin.from('organizations').select('app_webhooks_disabled_at, app_webhooks_disabled_reason').eq('id', organizationId).maybeSingle();
  if (error) throw new Error(`organizations webhook switch: ${error.message}`);
  return stateOf(data as OrgRow | null);
}

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

export function webhookSwitchView(state: WebhookSwitchState, actor: ActorScope): WebhookSwitchView {
  return { ...state, canChange: actor.isAdmin && actor.managesWholeOrganization };
}

export type SwitchResult = { ok: true; data: WebhookSwitchView } | { ok: false; status: number; message: string };

/**
 * 끄기·켜기 — 기관 전체를 관리하는 관리자만. 조건부로 바꾸고(이미 그 상태면 바꾸지 않고 기록도 남기지 않는다) 바뀌었을 때만 보안 로그.
 * 끌 때의 사유는 저장해 관리자·직원 화면에 보이고, 켤 때의 사유는 보안 로그에만 남는다
 */
export async function setWebhookSwitch(
  admin: { scope: ActorScope; userId: string; impersonating: boolean }, enabled: boolean, reason: string, nowMs: number,
): Promise<SwitchResult> {
  const actor = admin.scope;
  if (!actor.organizationId) return { ok: false, status: 403, message: '기관 소속을 확인할 수 없습니다.' };
  if (!actor.isAdmin || !actor.managesWholeOrganization) return { ok: false, status: 403, message: '기관 전체 외부 연동은 기관 전체를 관리하는 관리자(최상위 부서 소속)만 끄고 켤 수 있습니다.' };
  const base = supabaseAdmin.from('organizations');
  const { data: changed, error } = enabled
    ? await base.update({ app_webhooks_disabled_at: null, app_webhooks_disabled_reason: null }).eq('id', actor.organizationId).not('app_webhooks_disabled_at', 'is', null).select('id')
    : await base.update({ app_webhooks_disabled_at: new Date(nowMs).toISOString(), app_webhooks_disabled_reason: reason }).eq('id', actor.organizationId).is('app_webhooks_disabled_at', null).select('id');
  if (error) return { ok: false, status: 503, message: enabled ? '외부 연동을 켜지 못했습니다.' : '외부 연동을 끄지 못했습니다.' };
  if (changed?.length) {
    await logSecurityEvent(actor.departmentId, admin.userId, enabled ? 'app_webhooks_org_enabled' : 'app_webhooks_org_disabled',
      { organization_id: actor.organizationId, reason, impersonating: admin.impersonating }, 'high');
  }
  try {
    return { ok: true, data: webhookSwitchView(await readWebhookSwitch(actor.organizationId), actor) };
  } catch {
    return { ok: false, status: 503, message: '외부 연동 설정을 다시 읽지 못했습니다.' };
  }
}
