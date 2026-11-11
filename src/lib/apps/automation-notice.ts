// src/lib/apps/automation-notice.ts
// 관리자가 직원의 앱 연동을 회수하거나 예약을 멈추·잠금을 풀었을 때 그 직원에게 알리는 메일(2026-11-08).
//
// - 받는 사람은 연동·예약의 주인 직원 한 사람(탈퇴·비활성 계정·주소 없음은 건너뜀). 관리자 이름은 싣지 않는다('기관 관리자').
// - 싣는 것: 무엇이(앱·연동 이름 또는 예약 주기) 어떻게 되었는지·시각·관리자가 적은 사유·할 일 링크. 입력값·결과·토큰은 싣지 않는다.
// - **던지지 않는다** — 메일이 안 가도 관리자의 회수·멈춤은 이미 끝났다. 실패는 운영 기록 warning(사유 글 없이)만.
import { supabaseAdmin } from '@/lib/supabaseAdmin';
import { APP_URL } from '@/lib/config';
import { logSystem } from '@/lib/logger';
import { automationAdminNoticeMail, isMailConfigured, sendAutomationAdminNoticeEmail, type AutomationNoticeKind } from '@/lib/mailer';
import { describeSchedule, specOfRow, type AppScheduleRowLike } from './schedule-spec';

export type AutomationNotice = {
  kind: AutomationNoticeKind;
  organizationId: string;
  userId: string;
  agentId: string;
  /** 연동 id 또는 예약 id */
  targetId: string;
  reason: string;
  at: Date;
};

async function targetLabel(n: AutomationNotice): Promise<string> {
  if (n.kind === 'batch_stopped') {
    const { data } = await supabaseAdmin.from('app_batches').select('name').eq('id', n.targetId).maybeSingle();
    const name = (data as { name?: unknown } | null)?.name;
    return typeof name === 'string' && name.trim() ? `일괄 실행 '${name.trim()}'` : '앱 일괄 실행';
  }
  if (n.kind === 'webhook_revoked') {
    const { data } = await supabaseAdmin.from('app_webhooks').select('name').eq('id', n.targetId).maybeSingle();
    const name = (data as { name?: unknown } | null)?.name;
    return typeof name === 'string' && name.trim() ? `연동 '${name.trim()}'` : '앱 연동';
  }
  const { data } = await supabaseAdmin.from('app_schedules').select('frequency, weekday, month_day, run_hour, run_minute').eq('id', n.targetId).maybeSingle();
  try { return data ? `${describeSchedule(specOfRow(data as AppScheduleRowLike))} 예약` : '앱 예약'; } catch { return '앱 예약'; }
}

/** 주인 직원에게 알린다 — 던지지 않는다 */
export async function notifyAutomationOwner(n: AutomationNotice): Promise<void> {
  try {
    if (!isMailConfigured()) return;
    const { data: user, error } = await supabaseAdmin.from('users').select('email, is_active, deleted_at').eq('id', n.userId).maybeSingle();
    if (error) throw new Error(`users: ${error.message}`);
    const owner = user as { email?: unknown; is_active?: unknown; deleted_at?: unknown } | null;
    const to = typeof owner?.email === 'string' ? owner.email.trim() : '';
    if (!to || owner?.deleted_at || owner?.is_active === false) return;
    const [{ data: agent }, target] = await Promise.all([
      supabaseAdmin.from('agents').select('name').eq('id', n.agentId).maybeSingle(),
      targetLabel(n),
    ]);
    const appName = typeof (agent as { name?: unknown } | null)?.name === 'string' ? (agent as { name: string }).name : '입력형 앱';
    const mail = automationAdminNoticeMail({
      kind: n.kind, appName, target, reason: n.reason, at: n.at,
      url: `${APP_URL}${n.kind === 'webhook_revoked' ? '/apps/webhooks' : n.kind === 'batch_stopped' ? `/apps/run?agent=${encodeURIComponent(n.agentId)}` : '/apps/schedules'}`,
    });
    const sent = await sendAutomationAdminNoticeEmail(to, mail);
    if (!sent.sent) throw new Error(sent.error ?? sent.reason ?? 'send_failed');
  } catch (error) {
    await logSystem({
      level: 'warning', category: 'api', message: '관리자 조치 알림 메일을 보내지 못함',
      details: { kind: n.kind, target_id: n.targetId, error: error instanceof Error ? error.message.slice(0, 200) : 'unknown' }, orgId: n.organizationId,
    });
  }
}
