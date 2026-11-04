import { supabaseAdmin } from '@/lib/supabaseAdmin';
import { APP_URL } from '@/lib/config';
import { logSystem } from '@/lib/logger';
import { budgetAlertMail, isMailConfigured, personalBudgetAlertMail, sendBudgetAlertEmail, type MailResult } from '@/lib/mailer';
import {
  departmentBudgetStatuses, organizationBudgetStatus, userBudgetStatuses,
  type DepartmentBudgetStatus, type OrganizationBudgetStatus, type UserBudgetStatus,
} from '@/lib/usage-limit';

/**
 * 기관·부서 예산 알림 메일 (0045).
 *
 * 화면(`/admin/organization`)은 기준을 넘으면 경고만 보여 주고, 100%면 직원 요청이 막힌다. 관리자가 화면을 열지 않으면
 * 막힌 뒤에야 안다 — 공공기관은 예산 증액에 결재가 필요해 미리 알아야 한다. 그래서 하루 한 번(예약 작업) 사용률을 보고
 * 기준을 넘었으면 관리자에게 메일을 보낸다. 대상은 둘이다.
 *
 * - **기관**: 연간 정액 계약(기준 = 계약의 `budget_alert_percent`(기본 80)·90·100) 또는 종량제 월 토큰 한도(80·90·100).
 *   받는 사람은 기관 담당자 메일(`organizations.contact_email`) + 최상위 부서의 활성 관리자.
 * - **부서 월 한도(0024)**: 기준 80·90·100. 받는 사람은 그 부서와 상위 부서의 활성 관리자(그 부서를 관리하는 사람).
 *
 * - 같은 대상·같은 기간(연간 계약 id, 그 밖은 KST 달)·같은 기준은 **한 번만**(`budget_alerts` 유일 키로 차지한 실행만 보낸다).
 * - 한 번에 여러 기준을 건너뛰었으면(70% → 100%) **가장 높은 기준 하나만** 보낸다.
 * - 한 사람씩 따로 보낸다. 모두 실패하면 `failed`로 두고 다음 실행에서 다시(3번까지). 보내다 멈춘 차지(1시간 넘은 `sending`)도 다시 잡는다.
 * - 메일이 설정되지 않았으면 아무것도 차지하지 않는다(설정한 뒤 첫 실행에서 보낸다).
 * - 사용률을 모르면(집계 실패) 보내지 않는다 — 거짓 경보보다 하루 늦은 경보가 낫다. 한 대상의 실패가 다른 대상을 막지 않는다.
 * - 운영 기록에는 받는 사람 주소를 남기지 않는다(수만).
 * - **개인 월 한도(0024, 0052)**: 기준 80·90·100. 받는 사람은 **그 직원 본인**뿐(활성·탈퇴 아님·같은 기관). 기관 안 한도가 있는
 *   직원의 한도·사용액은 DB 함수 하나(`organization_user_budget_usage`)로 한 번에 읽는다. 대상 키 `user:{id}`, 기간은 KST 달.
 *   관리자에게는 보내지 않는다(관리자는 이용 현황 화면에서 본다 — 직원 한 사람 한 사람의 사용률을 메일로 돌리지 않는다).
 */

export const MAX_ALERT_ATTEMPTS = 3;
export const STALE_SENDING_MS = 60 * 60 * 1000;
const MAX_RECIPIENTS = 20;
const EMAIL = /^[^\s@<>"']+@[^\s@<>"']+\.[^\s@<>"']+$/;

/** 보낼 기준들 — 첫 경고 기준, (그보다 크면) 90, 100. 오름차순·중복 없음 */
export function budgetThresholds(alertPercent: number): number[] {
  const first = Number.isFinite(alertPercent) ? Math.min(100, Math.max(1, Math.round(alertPercent))) : 80;
  return [...new Set([first, ...(first < 90 ? [90] : []), 100])].sort((a, b) => a - b);
}

/** 지금 사용률이 넘은 가장 높은 기준. 하나도 안 넘었으면 null */
export function thresholdToSend(percent: number, thresholds: number[]): number | null {
  const crossed = thresholds.filter((t) => percent >= t);
  return crossed.length ? crossed[crossed.length - 1] : null;
}

/** 주소 다듬기 — 소문자·중복 제거·꼴이 맞는 것만·상한 */
export function cleanRecipients(raw: Array<string | null | undefined>): string[] {
  const seen = new Set<string>();
  for (const value of raw) {
    if (seen.size >= MAX_RECIPIENTS) break;
    const email = (value ?? '').trim().toLowerCase();
    if (EMAIL.test(email)) seen.add(email);
  }
  return [...seen];
}

/** 이미 있는 기록을 다시 보낼 수 있는가 — 실패했거나 보내다 멈췄고(1시간), 3번 안쪽 */
export function retakeable(row: { status: string; attempts: number; updated_at: string }, now: number): boolean {
  if (row.attempts >= MAX_ALERT_ATTEMPTS) return false;
  if (row.status === 'failed') return true;
  return row.status === 'sending' && now - new Date(row.updated_at).getTime() > STALE_SENDING_MS;
}

/** 알림 대상 하나의 사용률 — 기관(`org`), 부서(`dept:{id}`) 또는 직원(`user:{id}`) */
export interface BudgetSubjectStatus {
  subject: string;
  departmentName: string | null;
  kind: 'annual_budget' | 'monthly_tokens' | 'department_monthly' | 'user_monthly';
  periodKey: string;
  used: number;
  limit: number;
  percent: number;
  alertPercent: number;
  periodEndsAt: string | null;
}

export function organizationSubject(status: OrganizationBudgetStatus): BudgetSubjectStatus {
  return { ...status, subject: 'org', departmentName: null };
}

export function departmentSubject(status: DepartmentBudgetStatus): BudgetSubjectStatus {
  return {
    subject: `dept:${status.departmentId}`,
    departmentName: status.departmentName,
    kind: 'department_monthly',
    periodKey: status.periodKey,
    used: status.used,
    limit: status.limit,
    percent: status.percent,
    alertPercent: 80,
    periodEndsAt: null,
  };
}

export function userSubject(status: UserBudgetStatus): BudgetSubjectStatus {
  return {
    subject: `user:${status.userId}`,
    departmentName: null,
    kind: 'user_monthly',
    periodKey: status.periodKey,
    used: status.used,
    limit: status.limit,
    percent: status.percent,
    alertPercent: 80,
    periodEndsAt: null,
  };
}

export interface BudgetAlertClaim {
  organizationId: string;
  subject: string;
  periodKey: string;
  threshold: number;
  kind: BudgetSubjectStatus['kind'];
  percent: number;
}

export interface BudgetAlertDeps {
  mailConfigured(): boolean;
  organizations(): Promise<Array<{ id: string; name: string }>>;
  status(organizationId: string): Promise<OrganizationBudgetStatus | null>;
  departmentStatuses(organizationId: string): Promise<{ statuses: DepartmentBudgetStatus[]; failed: number }>;
  /** 개인 월 한도가 있는 직원들의 사용률 — 못 읽으면 던진다 */
  userStatuses(organizationId: string): Promise<UserBudgetStatus[]>;
  recipients(organizationId: string, subject: string): Promise<string[]>;
  /** 개인 알림의 받는 사람 — 같은 기관의 활성(탈퇴 아님) 직원 본인. 아니면 null */
  person(organizationId: string, userId: string): Promise<{ email: string; name: string | null } | null>;
  /** 이 알림을 보낼 차례면 true — 새로 넣었거나, 실패·멈춘 차지를 조건부로 다시 잡았다 */
  claim(claim: BudgetAlertClaim): Promise<boolean>;
  finish(claim: BudgetAlertClaim, result: { status: 'sent' | 'failed' | 'no_recipients'; recipients: number }): Promise<void>;
  send(to: string, mail: { subject: string; html: string }): Promise<MailResult>;
  log(level: 'info' | 'warning', message: string, details: Record<string, unknown>, organizationId: string): Promise<void>;
  now(): number;
}

export interface BudgetAlertRun {
  /** 살펴본 기관 수 */
  checked: number;
  /** 보낸 알림 수(대상·기준 하나가 한 건) */
  sent: number;
  failed: number;
  skipped: 'not_configured' | null;
  /** 시간 예산에 닿아 남은 기관을 다음 실행에 넘겼다 */
  partial: boolean;
}

const errorText = (error: unknown) => (error instanceof Error ? error.message.slice(0, 200) : 'unknown');

/** 대상 하나 — 보냈으면 'sent', 모두 실패면 'failed', 보낼 것 없음·이미 보냄·받는 사람 없음은 'none' */
async function alertSubject(deps: BudgetAlertDeps, org: { id: string; name: string }, status: BudgetSubjectStatus): Promise<'sent' | 'failed' | 'none'> {
  const threshold = thresholdToSend(status.percent, budgetThresholds(status.alertPercent));
  if (threshold === null) return 'none';
  const claim: BudgetAlertClaim = {
    organizationId: org.id, subject: status.subject, periodKey: status.periodKey, threshold, kind: status.kind, percent: status.percent,
  };
  if (!(await deps.claim(claim))) return 'none';
  const facts = { subject: status.subject, threshold, percent: status.percent, kind: status.kind };
  if (status.kind === 'user_monthly') {
    // 직원 본인에게만. 주소가 없거나(꼴이 틀림) 그 사이 비활성·탈퇴했으면 받을 사람 없음으로 닫는다
    const person = await deps.person(org.id, status.subject.slice('user:'.length));
    const email = person ? cleanRecipients([person.email])[0] : undefined;
    if (!email) {
      await deps.finish(claim, { status: 'no_recipients', recipients: 0 });
      return 'none';
    }
    const mail = personalBudgetAlertMail({
      organizationName: org.name, userName: person!.name, threshold, used: status.used, limit: status.limit, percent: status.percent,
      statsUrl: `${APP_URL.replace(/\/+$/, '')}/my/stats`, checkedAt: new Date(deps.now()),
    });
    const delivered = (await deps.send(email, mail)).sent ? 1 : 0;
    await deps.finish(claim, { status: delivered ? 'sent' : 'failed', recipients: delivered });
    if (!delivered) await deps.log('warning', '개인 한도 알림 메일을 보내지 못했습니다', facts, org.id);
    return delivered ? 'sent' : 'failed';
  }
  const recipients = await deps.recipients(org.id, status.subject);
  if (!recipients.length) {
    await deps.finish(claim, { status: 'no_recipients', recipients: 0 });
    await deps.log('warning', '예산 알림을 받을 관리자 메일이 없습니다', facts, org.id);
    return 'none';
  }
  const department = status.kind === 'department_monthly';
  const mail = budgetAlertMail({
    organizationName: org.name,
    departmentName: status.departmentName,
    kind: status.kind,
    threshold,
    used: status.used,
    limit: status.limit,
    percent: status.percent,
    periodEndsAt: status.periodEndsAt,
    adminUrl: `${APP_URL.replace(/\/+$/, '')}/admin/${department ? 'departments' : 'organization'}`,
    checkedAt: new Date(deps.now()),
  });
  let delivered = 0;
  for (const to of recipients) if ((await deps.send(to, mail)).sent) delivered += 1;
  await deps.finish(claim, { status: delivered ? 'sent' : 'failed', recipients: delivered });
  await deps.log(
    delivered ? 'info' : 'warning',
    delivered ? '예산 알림 메일을 보냈습니다' : '예산 알림 메일을 보내지 못했습니다',
    { ...facts, recipients: recipients.length, delivered },
    org.id
  );
  return delivered ? 'sent' : 'failed';
}

export async function runBudgetAlerts(deps: BudgetAlertDeps, budgetMs = 50_000): Promise<BudgetAlertRun> {
  const run: BudgetAlertRun = { checked: 0, sent: 0, failed: 0, skipped: null, partial: false };
  if (!deps.mailConfigured()) return { ...run, skipped: 'not_configured' };
  const started = deps.now();
  const organizations = await deps.organizations();
  for (const org of organizations) {
    if (deps.now() - started > budgetMs) { run.partial = true; break; }
    run.checked += 1;
    const subjects: BudgetSubjectStatus[] = [];
    try {
      const status = await deps.status(org.id);
      if (status) subjects.push(organizationSubject(status));
    } catch (error) {
      run.failed += 1;
      await deps.log('warning', '기관 예산 사용률을 확인하지 못했습니다', { error: errorText(error) }, org.id);
    }
    try {
      const departments = await deps.departmentStatuses(org.id);
      subjects.push(...departments.statuses.map(departmentSubject));
      if (departments.failed) {
        run.failed += departments.failed;
        await deps.log('warning', '부서 예산 사용률을 확인하지 못했습니다', { departments: departments.failed }, org.id);
      }
    } catch (error) {
      run.failed += 1;
      await deps.log('warning', '부서 예산 사용률을 확인하지 못했습니다', { error: errorText(error) }, org.id);
    }
    try {
      subjects.push(...(await deps.userStatuses(org.id)).map(userSubject));
    } catch (error) {
      run.failed += 1;
      await deps.log('warning', '개인 한도 사용률을 확인하지 못했습니다', { error: errorText(error) }, org.id);
    }
    for (const status of subjects) {
      try {
        const result = await alertSubject(deps, org, status);
        if (result === 'sent') run.sent += 1;
        if (result === 'failed') run.failed += 1;
      } catch (error) {
        run.failed += 1;
        await deps.log('warning', '예산 알림 중 오류가 났습니다', { subject: status.subject, error: errorText(error) }, org.id);
      }
    }
  }
  return run;
}

async function activeAdminEmails(departmentIds: string[]): Promise<string[]> {
  if (!departmentIds.length) return [];
  const { data, error } = await supabaseAdmin
    .from('users')
    .select('email')
    .in('department_id', departmentIds)
    .eq('role', 'ADMIN')
    .eq('is_active', true);
  if (error) throw new Error(`users: ${error.message}`);
  return (data ?? []).map((u: { email: string }) => u.email);
}

/** Supabase에 붙은 기본 의존 */
export function budgetAlertDeps(): BudgetAlertDeps {
  return {
    mailConfigured: isMailConfigured,
    async organizations() {
      const { data, error } = await supabaseAdmin.from('organizations').select('id, name, status').neq('status', 'suspended');
      if (error) throw new Error(`organizations: ${error.message}`);
      return (data ?? []).map((o: { id: string; name: string }) => ({ id: o.id, name: o.name }));
    },
    status: organizationBudgetStatus,
    departmentStatuses: departmentBudgetStatuses,
    userStatuses: userBudgetStatuses,
    async person(organizationId, userId) {
      // 기관은 부서로 확인한다(사람 행에는 기관 칸이 없다) — 다른 기관 직원에게 보내지 않게
      const { data, error } = await supabaseAdmin
        .from('users')
        .select('email, full_name, is_active, deleted_at, department:departments!inner(organization_id)')
        .eq('id', userId)
        .maybeSingle();
      if (error) throw new Error(`users: ${error.message}`);
      const row = data as { email: string | null; full_name: string | null; is_active: boolean | null; deleted_at: string | null; department: { organization_id: string } | { organization_id: string }[] | null } | null;
      const dept = Array.isArray(row?.department) ? row?.department[0] : row?.department;
      if (!row || row.is_active !== true || row.deleted_at || dept?.organization_id !== organizationId || !row.email) return null;
      return { email: row.email, name: row.full_name };
    },
    async recipients(organizationId, subject) {
      if (subject.startsWith('dept:')) {
        const departmentId = subject.slice('dept:'.length);
        // 그 부서를 관리하는 사람 = 그 부서와 상위 부서의 관리자(department-scope의 관리 범위와 같은 방향)
        const { data: ancestors, error } = await supabaseAdmin.rpc('department_ancestors', { p_department_id: departmentId });
        if (error) throw new Error(`department_ancestors: ${error.message}`);
        const ids = ((ancestors ?? []) as Array<{ id: string }>).map((d) => d.id);
        // 기관을 넘지 않게 같은 기관의 부서만
        const { data: own, error: ownError } = ids.length
          ? await supabaseAdmin.from('departments').select('id').in('id', ids).eq('organization_id', organizationId)
          : { data: [], error: null };
        if (ownError) throw new Error(`departments: ${ownError.message}`);
        return cleanRecipients(await activeAdminEmails((own ?? []).map((d: { id: string }) => d.id)));
      }
      const { data: org } = await supabaseAdmin.from('organizations').select('contact_email').eq('id', organizationId).maybeSingle();
      const { data: roots, error } = await supabaseAdmin
        .from('departments')
        .select('id')
        .eq('organization_id', organizationId)
        .is('parent_id', null);
      if (error) throw new Error(`departments: ${error.message}`);
      const admins = await activeAdminEmails((roots ?? []).map((d: { id: string }) => d.id));
      return cleanRecipients([org?.contact_email, ...admins]);
    },
    async claim(c) {
      const row = {
        organization_id: c.organizationId, subject: c.subject, period_key: c.periodKey, threshold: c.threshold,
        kind: c.kind, percent: c.percent, status: 'sending',
      };
      const inserted = await supabaseAdmin.from('budget_alerts').insert(row).select('id');
      if (!inserted.error) return true;
      if (inserted.error.code !== '23505') throw new Error(`budget_alerts: ${inserted.error.message}`);
      const { data: existing, error } = await supabaseAdmin
        .from('budget_alerts')
        .select('id, status, attempts, updated_at')
        .eq('organization_id', c.organizationId)
        .eq('subject', c.subject)
        .eq('period_key', c.periodKey)
        .eq('threshold', c.threshold)
        .maybeSingle();
      if (error) throw new Error(`budget_alerts: ${error.message}`);
      if (!existing || !retakeable(existing, Date.now())) return false;
      // 조건부 — 같은 순간 다른 실행이 먼저 잡았으면 0행
      const { data: taken, error: takeError } = await supabaseAdmin
        .from('budget_alerts')
        .update({ status: 'sending', attempts: existing.attempts + 1, percent: c.percent, updated_at: new Date().toISOString() })
        .eq('id', existing.id)
        .eq('status', existing.status)
        .eq('attempts', existing.attempts)
        .select('id');
      if (takeError) throw new Error(`budget_alerts: ${takeError.message}`);
      return (taken ?? []).length === 1;
    },
    async finish(c, result) {
      const { error } = await supabaseAdmin
        .from('budget_alerts')
        .update({ status: result.status, recipients: result.recipients, updated_at: new Date().toISOString() })
        .eq('organization_id', c.organizationId)
        .eq('subject', c.subject)
        .eq('period_key', c.periodKey)
        .eq('threshold', c.threshold);
      if (error) throw new Error(`budget_alerts: ${error.message}`);
    },
    send: sendBudgetAlertEmail,
    log: (level, message, details, organizationId) => logSystem({ level, category: 'admin', message, details, orgId: organizationId }),
    now: () => Date.now(),
  };
}
