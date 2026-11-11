// src/lib/apps/outbound/notices.ts
// 앱 결과 보내기 알림(2026-11-10, 0081) — 앱 예약 실행기(pg_cron 5분)가 보내기와 나란히 부른다. 던지지 않는다.
//
// ① 보내기가 그만둔 일 → 그 기관의 기관 전체 관리자(최상위 부서 소속 관리자)에게. 보낼 곳마다 **6시간에 한 번**
//    (`app_outbound_endpoints.failure_notified_at`을 조건부로 차지한 쪽만 보냄). 대상은 실제로 보내 보고 그만둔 기록(시도 1번 이상)만 —
//    확인 기한이 지나 그만둔 것·회수로 그만둔 것은 사람이 정한 일이라 알리지 않는다.
// ② 보내기 전 확인(0078)을 기다리는 결과 → 그 결과를 실행한 직원에게 **결과마다 한 번**(`app_outbound_deliveries.approval_notified_at`).
//    실행을 마치고 10분이 지나도 정하지 않은 것만 — 실행 화면에 있는 직원은 그 사이에 정한다. 직원 한 명에게 한 통으로 묶는다.
// 메일에는 이름·수·마감·링크만 싣고 결과 글·받는 쪽 응답은 싣지 않는다. 메일이 설정되지 않았으면 아무것도 차지하지 않는다.
import { supabaseAdmin } from '@/lib/supabaseAdmin';
import { APP_URL } from '@/lib/config';
import { logSystem } from '@/lib/logger';
import { approvalWaitingMail, isMailConfigured, outboundFailureMail, sendOutboundNoticeEmail } from '@/lib/mailer';
import { OUTBOUND_APPROVAL_MS, approvalExpiresAt } from './spec';

/** 같은 보낼 곳의 그만둠 알림 간격 */
export const FAILURE_NOTICE_INTERVAL_MS = 6 * 3_600_000;
/** 처음 알릴 때 거슬러 보는 기간(알린 적이 없으면) */
export const FAILURE_LOOKBACK_MS = 24 * 3_600_000;
/** 확인 기다림을 알리기까지 기다리는 시간 — 실행 화면에서 바로 정하는 직원에게는 보내지 않게 */
export const APPROVAL_NOTICE_DELAY_MS = 10 * 60_000;

export interface FailureEndpoint { id: string; organization_id: string; name: string; failure_notified_at: string | null }
export interface WaitingDelivery { id: string; user_id: string; agent_id: string; organization_id: string; created_at: string }

export interface OutboundNoticeDeps {
  now(): number;
  mailConfigured(): boolean;
  /** 회수되지 않은 보낼 곳 중, 알림 뒤(없으면 24시간 안)에 실제로 보내 보고 그만둔 기록이 있는 곳 — 수·마지막 이유와 함께 */
  failingEndpoints(nowIso: string, lookbackIso: string): Promise<Array<FailureEndpoint & { count: number; lastError: string | null; since: string }>>;
  /** 알린 때를 조건부로 바꿈(그 사이 다른 호출이 알렸으면 false) */
  claimFailureNotice(endpoint: FailureEndpoint, nowIso: string): Promise<boolean>;
  orgAdminEmails(organizationId: string): Promise<string[]>;
  /** 확인 기다림·기한 안·아직 알리지 않음·10분 지남 */
  waitingDeliveries(beforeIso: string, notBeforeIso: string, limit: number): Promise<WaitingDelivery[]>;
  /** 알린 때를 조건부로 찍고 실제로 찍은 id */
  claimApprovalNotices(ids: string[], nowIso: string): Promise<string[]>;
  /** 직원 주소 — 그 기관의 활성 직원일 때만 */
  userEmail(userId: string, organizationId: string): Promise<string | null>;
  appNames(agentIds: string[]): Promise<Map<string, string>>;
  send(to: string, mail: { subject: string; html: string }): Promise<{ sent: boolean }>;
  log(message: string, details: Record<string, unknown>, orgId?: string): Promise<void>;
}

export type OutboundNoticeResult = { failureMails: number; approvalMails: number };

export async function runOutboundNotices(deps: OutboundNoticeDeps = outboundNoticeDeps()): Promise<OutboundNoticeResult> {
  const result: OutboundNoticeResult = { failureMails: 0, approvalMails: 0 };
  if (!deps.mailConfigured()) return result;
  const now = deps.now();
  const iso = (ms: number) => new Date(ms).toISOString();

  // ① 그만둔 보내기 → 기관 전체 관리자
  try {
    const failing = await deps.failingEndpoints(iso(now), iso(now - FAILURE_LOOKBACK_MS));
    for (const ep of failing) {
      if (ep.failure_notified_at && Date.parse(ep.failure_notified_at) > now - FAILURE_NOTICE_INTERVAL_MS) continue;
      if (!(await deps.claimFailureNotice(ep, iso(now)).catch(() => false))) continue;
      const emails = await deps.orgAdminEmails(ep.organization_id).catch(() => [] as string[]);
      const mail = outboundFailureMail({ endpointName: ep.name, count: ep.count, lastError: ep.lastError, since: new Date(ep.since), url: `${APP_URL}/admin/app-automations` });
      let delivered = 0;
      for (const to of emails) if ((await deps.send(to, mail).catch(() => ({ sent: false }))).sent) delivered++;
      if (delivered) result.failureMails += delivered;
      else await deps.log('앱 결과 보내기 그만둠 알림을 보내지 못했습니다', { endpoint_id: ep.id, recipients: emails.length }, ep.organization_id).catch(() => {});
    }
  } catch (error) {
    await deps.log('앱 결과 보내기 그만둠 알림을 확인하지 못했습니다', { error: error instanceof Error ? error.message.slice(0, 200) : 'unknown' }).catch(() => {});
  }

  // ② 확인 기다림 → 실행한 직원(한 사람에 한 통)
  try {
    const waiting = await deps.waitingDeliveries(iso(now - APPROVAL_NOTICE_DELAY_MS), iso(now - OUTBOUND_APPROVAL_MS), 200);
    const claimed = new Set(waiting.length ? await deps.claimApprovalNotices(waiting.map((w) => w.id), iso(now)) : []);
    const byUser = new Map<string, WaitingDelivery[]>();
    for (const w of waiting) if (claimed.has(w.id)) byUser.set(w.user_id, [...(byUser.get(w.user_id) ?? []), w]);
    if (byUser.size) {
      const names = await deps.appNames([...new Set([...claimed].map((id) => waiting.find((w) => w.id === id)!.agent_id))]).catch(() => new Map<string, string>());
      for (const [userId, rows] of byUser) {
        const to = await deps.userEmail(userId, rows[0].organization_id).catch(() => null);
        if (!to) continue;
        const perApp = new Map<string, number>();
        for (const r of rows) perApp.set(r.agent_id, (perApp.get(r.agent_id) ?? 0) + 1);
        const mail = approvalWaitingMail({
          total: rows.length,
          earliestDeadline: new Date(Math.min(...rows.map((r) => approvalExpiresAt(r.created_at)))),
          apps: [...perApp].map(([agentId, count]) => ({ name: names.get(agentId) ?? '입력형 앱', count, url: `${APP_URL}/apps/run?agent=${encodeURIComponent(agentId)}` })),
        });
        if ((await deps.send(to, mail).catch(() => ({ sent: false }))).sent) result.approvalMails++;
        else await deps.log('보내기 전 확인 알림을 보내지 못했습니다', { user_id: userId, count: rows.length }, rows[0].organization_id).catch(() => {});
      }
    }
  } catch (error) {
    await deps.log('보내기 전 확인 알림을 확인하지 못했습니다', { error: error instanceof Error ? error.message.slice(0, 200) : 'unknown' }).catch(() => {});
  }
  return result;
}

export function outboundNoticeDeps(): OutboundNoticeDeps {
  return {
    now: () => Date.now(),
    mailConfigured: isMailConfigured,
    async failingEndpoints(_nowIso, lookbackIso) {
      const { data: endpoints, error } = await supabaseAdmin.from('app_outbound_endpoints').select('id, organization_id, name, failure_notified_at').is('revoked_at', null).limit(500);
      if (error) throw new Error(error.message);
      const out: Array<FailureEndpoint & { count: number; lastError: string | null; since: string }> = [];
      for (const ep of (endpoints ?? []) as FailureEndpoint[]) {
        const since = ep.failure_notified_at && ep.failure_notified_at > lookbackIso ? ep.failure_notified_at : lookbackIso;
        const { data, count, error: dErr } = await supabaseAdmin.from('app_outbound_deliveries').select('last_error', { count: 'exact' })
          .eq('endpoint_id', ep.id).eq('status', 'gave_up').gte('attempts', 1).gt('created_at', since).order('created_at', { ascending: false }).limit(1);
        if (dErr) throw new Error(dErr.message);
        if (count) out.push({ ...ep, count, lastError: ((data ?? [])[0] as { last_error: string | null } | undefined)?.last_error ?? null, since });
      }
      return out;
    },
    async claimFailureNotice(ep, nowIso) {
      let q = supabaseAdmin.from('app_outbound_endpoints').update({ failure_notified_at: nowIso }).eq('id', ep.id);
      q = ep.failure_notified_at ? q.eq('failure_notified_at', ep.failure_notified_at) : q.is('failure_notified_at', null);
      const { data, error } = await q.select('id');
      return !error && Boolean(data?.length);
    },
    async orgAdminEmails(organizationId) {
      const { data: roots, error } = await supabaseAdmin.from('departments').select('id').eq('organization_id', organizationId).is('parent_id', null);
      if (error) throw new Error(error.message);
      const ids = (roots ?? []).map((d: { id: string }) => d.id);
      if (!ids.length) return [];
      const { data: users, error: uErr } = await supabaseAdmin.from('users').select('email').in('department_id', ids).eq('role', 'ADMIN').eq('is_active', true).is('deleted_at', null);
      if (uErr) throw new Error(uErr.message);
      return [...new Set((users ?? []).map((u: { email: string | null }) => (u.email ?? '').trim()).filter((e: string) => e.length > 0))] as string[];
    },
    async waitingDeliveries(beforeIso, notBeforeIso, limit) {
      const { data, error } = await supabaseAdmin.from('app_outbound_deliveries').select('id, user_id, agent_id, organization_id, created_at')
        .eq('status', 'awaiting_approval').is('approval_notified_at', null).not('user_id', 'is', null).lt('created_at', beforeIso).gt('created_at', notBeforeIso)
        .order('created_at', { ascending: true }).limit(limit);
      if (error) throw new Error(error.message);
      return (data ?? []) as WaitingDelivery[];
    },
    async claimApprovalNotices(ids, nowIso) {
      const { data, error } = await supabaseAdmin.from('app_outbound_deliveries').update({ approval_notified_at: nowIso })
        .in('id', ids).eq('status', 'awaiting_approval').is('approval_notified_at', null).select('id');
      if (error) throw new Error(error.message);
      return (data ?? []).map((r: { id: string }) => r.id);
    },
    async userEmail(userId, organizationId) {
      const { data } = await supabaseAdmin.from('users').select('email, is_active, deleted_at, department:departments!inner(organization_id)').eq('id', userId).maybeSingle();
      const row = data as { email: string | null; is_active: boolean | null; deleted_at: string | null; department: { organization_id: string } | { organization_id: string }[] | null } | null;
      const dept = Array.isArray(row?.department) ? row?.department[0] : row?.department;
      if (!row || row.is_active !== true || row.deleted_at || dept?.organization_id !== organizationId) return null;
      return row.email?.trim() || null;
    },
    async appNames(agentIds) {
      const { data } = await supabaseAdmin.from('agents').select('id, name').in('id', agentIds);
      return new Map(((data ?? []) as Array<{ id: string; name: string }>).map((a) => [a.id, a.name]));
    },
    send: (to, mail) => sendOutboundNoticeEmail(to, mail),
    async log(message, details, orgId) { await logSystem({ level: 'warning', category: 'api', message, details, ...(orgId ? { orgId } : {}) }); },
  };
}
