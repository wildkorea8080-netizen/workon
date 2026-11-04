import { readFileSync } from 'fs';
import { beforeEach, describe, expect, it, vi } from 'vitest';

type Result = { data?: unknown; error?: { message: string; code?: string } | null };
const state = vi.hoisted(() => ({ results: {} as Record<string, Result[]>, rpc: [] as Result[], calls: [] as unknown[][] }));
vi.mock('@/lib/supabaseAdmin', () => ({
  supabaseAdmin: {
    from(table: string) {
      const q: Record<string, unknown> = {};
      for (const method of ['select', 'insert', 'update', 'eq', 'neq', 'is', 'in', 'gt', 'gte', 'order', 'limit']) {
        q[method] = (...args: unknown[]) => { state.calls.push([table, method, ...args]); return q; };
      }
      const next = () => Promise.resolve({ data: null, error: null, ...(state.results[table]?.shift() ?? {}) });
      q.maybeSingle = () => { state.calls.push([table, 'maybeSingle']); return next(); };
      q.then = (resolve: (v: unknown) => unknown, reject?: (e: unknown) => unknown) => next().then(resolve, reject);
      return q;
    },
    rpc(name: string, args: unknown) { state.calls.push(['rpc', name, args]); return Promise.resolve({ data: null, error: null, ...(state.rpc.shift() ?? {}) }); },
  },
}));

import {
  budgetAlertDeps, budgetThresholds, cleanRecipients, retakeable, runBudgetAlerts, thresholdToSend, userSubject,
  type BudgetAlertDeps, type BudgetAlertClaim,
} from '@/lib/budget-alerts';
import { budgetAlertMail, personalBudgetAlertMail } from '@/lib/mailer';
import { departmentBudgetStatuses, organizationBudgetStatus, userBudgetStatuses, type OrganizationBudgetStatus } from '@/lib/usage-limit';

beforeEach(() => { state.results = {}; state.rpc = []; state.calls = []; });

describe('기준 고르기', () => {
  it('첫 경고 기준·90·100을 오름차순으로, 기준이 90 이상이면 90을 빼고', () => {
    expect(budgetThresholds(80)).toEqual([80, 90, 100]);
    expect(budgetThresholds(70)).toEqual([70, 90, 100]);
    expect(budgetThresholds(90)).toEqual([90, 100]);
    expect(budgetThresholds(95)).toEqual([95, 100]);
    expect(budgetThresholds(100)).toEqual([100]);
    expect(budgetThresholds(0)).toEqual([1, 90, 100]);
    expect(budgetThresholds(Number.NaN)).toEqual([80, 90, 100]);
  });
  it('넘은 기준 중 가장 높은 하나만 — 건너뛰면 아래 기준은 보내지 않는다', () => {
    const t = [80, 90, 100];
    expect(thresholdToSend(79, t)).toBeNull();
    expect(thresholdToSend(80, t)).toBe(80);
    expect(thresholdToSend(99, t)).toBe(90);
    expect(thresholdToSend(100, t)).toBe(100);
    expect(thresholdToSend(140, t)).toBe(100);
  });
  it('받는 주소는 소문자·중복 없이·꼴이 맞는 것만', () => {
    expect(cleanRecipients([' Admin@Org.go.kr ', 'admin@org.go.kr', null, '', 'not-mail', 'a@b', 'x<y>@z.kr', 'b@org.kr'])).toEqual(['admin@org.go.kr', 'b@org.kr']);
    expect(cleanRecipients(Array.from({ length: 30 }, (_, i) => `u${i}@org.kr`))).toHaveLength(20);
  });
  it('실패·멈춘 차지만 3번까지 다시 잡는다', () => {
    const now = Date.parse('2026-11-01T00:00:00Z');
    expect(retakeable({ status: 'failed', attempts: 1, updated_at: '2026-10-31T23:59:00Z' }, now)).toBe(true);
    expect(retakeable({ status: 'failed', attempts: 3, updated_at: '2026-10-31T00:00:00Z' }, now)).toBe(false);
    expect(retakeable({ status: 'sent', attempts: 1, updated_at: '2026-10-01T00:00:00Z' }, now)).toBe(false);
    expect(retakeable({ status: 'no_recipients', attempts: 1, updated_at: '2026-10-01T00:00:00Z' }, now)).toBe(false);
    expect(retakeable({ status: 'sending', attempts: 1, updated_at: '2026-10-31T23:30:00Z' }, now)).toBe(false);
    expect(retakeable({ status: 'sending', attempts: 1, updated_at: '2026-10-31T22:30:00Z' }, now)).toBe(true);
  });
});

const annual: OrganizationBudgetStatus = { kind: 'annual_budget', periodKey: 'contract:11111111-1111-4111-8111-111111111111', used: 9_100_000, limit: 10_000_000, percent: 91, alertPercent: 80, periodEndsAt: '2026-12-31T14:59:59Z' };

function fakeDeps(overrides: Partial<BudgetAlertDeps> = {}) {
  const sent: Array<{ to: string; subject: string }> = [];
  const finished: Array<[BudgetAlertClaim, unknown]> = [];
  const claims: BudgetAlertClaim[] = [];
  const logs: unknown[][] = [];
  const deps: BudgetAlertDeps = {
    mailConfigured: () => true,
    organizations: async () => [{ id: 'org-1', name: '시험기관' }],
    status: async () => annual,
    departmentStatuses: async () => ({ statuses: [], failed: 0 }),
    userStatuses: async () => [],
    recipients: async () => ['a@org.kr', 'b@org.kr'],
    person: async () => null,
    claim: async (c) => { claims.push(c); return true; },
    finish: async (c, r) => { finished.push([c, r]); },
    send: async (to, mail) => { sent.push({ to, subject: mail.subject }); return { sent: true }; },
    log: async (...args) => { logs.push(args); },
    now: () => Date.parse('2026-11-01T00:00:00Z'),
    ...overrides,
  };
  return { deps, sent, finished, claims, logs };
}

describe('알림 실행', () => {
  it('넘은 가장 높은 기준을 차지한 뒤 받는 사람마다 따로 보내고 sent로 남긴다', async () => {
    const f = fakeDeps();
    const run = await runBudgetAlerts(f.deps);
    expect(run).toEqual({ checked: 1, sent: 1, failed: 0, skipped: null, partial: false });
    expect(f.claims).toEqual([{ organizationId: 'org-1', subject: 'org', periodKey: annual.periodKey, threshold: 90, kind: 'annual_budget', percent: 91 }]);
    expect(f.sent.map((s) => s.to)).toEqual(['a@org.kr', 'b@org.kr']);
    expect(f.sent[0].subject).toContain('90% 도달');
    expect(f.finished[0][1]).toEqual({ status: 'sent', recipients: 2 });
    expect(JSON.stringify(f.logs)).not.toContain('@org.kr');
  });
  it('이미 보냈으면(차지 실패) 메일을 보내지 않는다', async () => {
    const f = fakeDeps({ claim: async () => false });
    expect((await runBudgetAlerts(f.deps)).sent).toBe(0);
    expect(f.sent).toEqual([]);
    expect(f.finished).toEqual([]);
  });
  it('메일이 설정되지 않았으면 아무것도 차지하지 않는다', async () => {
    const f = fakeDeps({ mailConfigured: () => false });
    expect((await runBudgetAlerts(f.deps)).skipped).toBe('not_configured');
    expect(f.claims).toEqual([]);
  });
  it('기준 아래·한도 없음·집계 실패는 보내지 않고, 실패는 다음 기관을 막지 않는다', async () => {
    const orgs = [{ id: 'low', name: 'A' }, { id: 'none', name: 'B' }, { id: 'broken', name: 'C' }, { id: 'full', name: 'D' }];
    const f = fakeDeps({
      organizations: async () => orgs,
      status: async (id) => {
        if (id === 'low') return { ...annual, percent: 79 };
        if (id === 'none') return null;
        if (id === 'broken') throw new Error('organization_spend_krw: down');
        return { ...annual, percent: 100, used: 10_000_000 };
      },
    });
    const run = await runBudgetAlerts(f.deps);
    expect(run).toMatchObject({ checked: 4, sent: 1, failed: 1 });
    expect(f.claims.map((c) => [c.organizationId, c.threshold])).toEqual([['full', 100]]);
    expect(f.sent[0].subject).toContain('모두 사용');
  });
  it('모두 실패하면 failed, 받을 사람이 없으면 no_recipients', async () => {
    const failing = fakeDeps({ send: async () => ({ sent: false, reason: 'send_failed' }) });
    expect((await runBudgetAlerts(failing.deps)).failed).toBe(1);
    expect(failing.finished[0][1]).toEqual({ status: 'failed', recipients: 0 });
    const nobody = fakeDeps({ recipients: async () => [] });
    await runBudgetAlerts(nobody.deps);
    expect(nobody.finished[0][1]).toEqual({ status: 'no_recipients', recipients: 0 });
    expect(nobody.sent).toEqual([]);
  });
  it('시간 예산에 닿으면 남은 기관은 다음 실행에 넘긴다', async () => {
    let t = 0;
    const f = fakeDeps({ organizations: async () => [{ id: 'a', name: 'A' }, { id: 'b', name: 'B' }], now: () => (t += 30_000) });
    const run = await runBudgetAlerts(f.deps, 50_000);
    expect(run.partial).toBe(true);
    expect(run.checked).toBe(1);
  });
});

describe('부서 월 한도 알림', () => {
  const dept = { departmentId: '33333333-3333-4333-8333-333333333333', departmentName: '총무과', periodKey: 'month:2026-11', used: 500_000, limit: 500_000, percent: 100 };
  it('기관과 부서를 따로 차지하고, 부서 메일은 부서 이름·부서 관리 화면으로 간다', async () => {
    const mails: Array<{ to: string; subject: string; html: string }> = [];
    const recipientsFor: string[] = [];
    const f = fakeDeps({
      departmentStatuses: async () => ({ statuses: [dept], failed: 0 }),
      recipients: async (_org, subject) => { recipientsFor.push(subject); return subject === 'org' ? ['boss@org.kr'] : ['dept-admin@org.kr']; },
      send: async (to, mail) => { mails.push({ to, ...mail }); return { sent: true }; },
    });
    const run = await runBudgetAlerts(f.deps);
    expect(run.sent).toBe(2);
    expect(f.claims.map((c) => [c.subject, c.threshold, c.kind])).toEqual([['org', 90, 'annual_budget'], ['dept:33333333-3333-4333-8333-333333333333', 100, 'department_monthly']]);
    expect(recipientsFor).toEqual(['org', 'dept:33333333-3333-4333-8333-333333333333']);
    const deptMail = mails.find((m) => m.to === 'dept-admin@org.kr')!;
    expect(deptMail.subject).toContain('총무과');
    expect(deptMail.subject).toContain('모두 사용');
    expect(deptMail.html).toContain('/admin/departments');
    expect(deptMail.html).toContain('이 부서 직원');
    expect(deptMail.html).toContain('500,000원 / 500,000원 (100%)');
  });
  it('부서 집계가 실패해도 기관 알림은 가고, 실패 수만 남긴다', async () => {
    const f = fakeDeps({ departmentStatuses: async () => ({ statuses: [], failed: 2 }) });
    const run = await runBudgetAlerts(f.deps);
    expect(run).toMatchObject({ sent: 1, failed: 2 });
    expect(f.logs.some((l) => l[1] === '부서 예산 사용률을 확인하지 못했습니다')).toBe(true);
    const throwing = fakeDeps({ departmentStatuses: async () => { throw new Error('departments: down'); } });
    expect((await runBudgetAlerts(throwing.deps))).toMatchObject({ sent: 1, failed: 1 });
  });
  it('기관 집계가 실패해도 부서 알림은 간다', async () => {
    const f = fakeDeps({ status: async () => { throw new Error('organization_spend_krw: down'); }, departmentStatuses: async () => ({ statuses: [{ ...dept, percent: 85, used: 425_000 }], failed: 0 }) });
    const run = await runBudgetAlerts(f.deps);
    expect(run).toMatchObject({ sent: 1, failed: 1 });
    expect(f.claims.map((c) => [c.subject, c.threshold])).toEqual([['dept:33333333-3333-4333-8333-333333333333', 80]]);
  });
  it('부서 사용률 — 한도를 둔 부서만, 집계가 실패한 부서는 빼고 센다', async () => {
    state.results.departments = [{ data: [{ id: 'd1', name: '총무과', monthly_budget_krw: '1000000.00' }, { id: 'd2', name: '기획과', monthly_budget_krw: 200_000 }] }];
    state.rpc = [{ data: 899_999 }, { error: { message: 'down' } }];
    const result = await departmentBudgetStatuses('org-1');
    expect(result.failed).toBe(1);
    expect(result.statuses).toHaveLength(1);
    expect(result.statuses[0]).toMatchObject({ departmentId: 'd1', departmentName: '총무과', used: 899_999, limit: 1_000_000, percent: 89 });
    expect(result.statuses[0].periodKey).toMatch(/^month:\d{4}-\d{2}$/);
    expect(state.calls).toContainEqual(['departments', 'eq', 'organization_id', 'org-1']);
    expect(state.calls).toContainEqual(['departments', 'gt', 'monthly_budget_krw', 0]);
  });
  it('부서 알림을 받는 사람은 그 부서와 상위 부서(같은 기관)의 활성 관리자 — 기관 담당자는 아님', async () => {
    state.rpc = [{ data: [{ id: '33333333-3333-4333-8333-333333333333' }, { id: 'root' }] }];
    state.results.departments = [{ data: [{ id: '33333333-3333-4333-8333-333333333333' }, { id: 'root' }] }];
    state.results.users = [{ data: [{ email: 'Dept@Org.kr' }, { email: 'root@org.kr' }] }];
    expect(await budgetAlertDeps().recipients('org-1', 'dept:33333333-3333-4333-8333-333333333333')).toEqual(['dept@org.kr', 'root@org.kr']);
    expect(state.calls).toContainEqual(['rpc', 'department_ancestors', { p_department_id: '33333333-3333-4333-8333-333333333333' }]);
    expect(state.calls).toContainEqual(['departments', 'eq', 'organization_id', 'org-1']);
    expect(state.calls).toContainEqual(['users', 'in', 'department_id', ['33333333-3333-4333-8333-333333333333', 'root']]);
    expect(state.calls.some((c) => c[0] === 'organizations')).toBe(false);
  });
});

describe('메일 글', () => {
  const base = { organizationName: '시험<기관>', kind: 'annual_budget' as const, used: 8_000_000, limit: 10_000_000, percent: 80, periodEndsAt: '2026-12-31T14:59:59Z', adminUrl: 'https://workon.example/admin/organization', checkedAt: new Date('2026-11-01T00:00:00Z') };
  it('기준 도달 메일 — 금액·한국 시각·계약 종료일·관리 화면 주소, 기관 이름은 이스케이프', () => {
    const m = budgetAlertMail({ ...base, threshold: 80 });
    expect(m.subject).toContain('연간 계약 예산 80% 도달');
    expect(m.html).toContain('8,000,000원 / 10,000,000원 (80%)');
    expect(m.html).toContain('2026-11-01 09:00 (한국 시간)');
    expect(m.html).toContain('2026-12-31');
    expect(m.html).toContain('https://workon.example/admin/organization');
    expect(m.html).toContain('시험&lt;기관&gt;');
    expect(m.html).not.toContain('시험<기관>');
    expect(m.html).toContain('100%가 되면');
  });
  it('100% 메일은 이용이 멈췄다고 알리고, 종량제는 토큰으로', () => {
    const full = budgetAlertMail({ ...base, threshold: 100, percent: 100 });
    expect(full.subject).toContain('모두 사용');
    expect(full.html).toContain('쓸 수 없습니다');
    const tokens = budgetAlertMail({ ...base, kind: 'monthly_tokens', threshold: 90, used: 900_000, limit: 1_000_000, percent: 90, periodEndsAt: null });
    expect(tokens.html).toContain('900,000 토큰 / 1,000,000 토큰');
    expect(tokens.html).not.toContain('계약 종료');
  });
});

describe('기관 사용률', () => {
  it('연간 정액 계약은 계약 기간 사용액, 기간 키는 계약 id, 내림 비율', async () => {
    state.results.contracts = [{ data: { id: '11111111-1111-4111-8111-111111111111', billing_type: 'annual_fixed', annual_budget_krw: 3_000_000, budget_alert_percent: 75, started_at: '2026-01-01T00:00:00Z', expires_at: '2026-12-31T14:59:59Z' } }];
    state.rpc = [{ data: 2_399_999 }];
    expect(await organizationBudgetStatus('org-1')).toEqual({ kind: 'annual_budget', periodKey: 'contract:11111111-1111-4111-8111-111111111111', used: 2_399_999, limit: 3_000_000, percent: 79, alertPercent: 75, periodEndsAt: '2026-12-31T14:59:59Z' });
  });
  it('종량제는 이번 달(KST) 대화 토큰, 한도 0이면 null, 집계 실패는 던진다', async () => {
    state.results.contracts = [{ data: null }];
    state.results.organizations = [{ data: { monthly_token_limit: 1000 } }];
    // 합은 DB 함수(0057) — 기록을 앱으로 읽지 않는다(1,000행 상한에서 덜 셈)
    state.rpc = [{ data: 900 }];
    const status = await organizationBudgetStatus('org-1');
    expect(status).toMatchObject({ kind: 'monthly_tokens', used: 900, limit: 1000, percent: 90, alertPercent: 80, periodEndsAt: null });
    expect(status?.periodKey).toMatch(/^month:\d{4}-\d{2}$/);
    expect(state.calls).toContainEqual(['rpc', 'organization_chat_tokens', expect.objectContaining({ p_organization_id: 'org-1' })]);
    expect(state.calls.some((c) => c[0] === 'usage_logs')).toBe(false);

    state.results.contracts = [{ data: null }];
    state.results.organizations = [{ data: { monthly_token_limit: 0 } }];
    expect(await organizationBudgetStatus('org-1')).toBeNull();

    state.results.contracts = [{ data: null }];
    state.results.organizations = [{ data: { monthly_token_limit: 1000 } }];
    state.rpc = [{ error: { message: 'down' } }];
    await expect(organizationBudgetStatus('org-1')).rejects.toThrow('organization_chat_tokens');
  });
});

describe('Supabase 차지', () => {
  const claim: BudgetAlertClaim = { organizationId: 'org-1', subject: 'org', periodKey: 'month:2026-11', threshold: 90, kind: 'monthly_tokens', percent: 92 };
  it('새 기록을 넣으면 차지한다', async () => {
    state.results.budget_alerts = [{ data: [{ id: 'x' }] }];
    expect(await budgetAlertDeps().claim(claim)).toBe(true);
    expect(state.calls).toContainEqual(['budget_alerts', 'insert', { organization_id: 'org-1', subject: 'org', period_key: 'month:2026-11', threshold: 90, kind: 'monthly_tokens', percent: 92, status: 'sending' }]);
  });
  it('이미 보낸 기록이면 차지하지 않는다', async () => {
    state.results.budget_alerts = [{ error: { message: 'dup', code: '23505' } }, { data: { id: 'x', status: 'sent', attempts: 1, updated_at: '2026-11-01T00:00:00Z' } }];
    expect(await budgetAlertDeps().claim(claim)).toBe(false);
    expect(state.calls.some((c) => c[0] === 'budget_alerts' && c[1] === 'update')).toBe(false);
  });
  it('실패 기록은 상태·시도 수가 그대로일 때만 조건부로 다시 잡는다', async () => {
    state.results.budget_alerts = [
      { error: { message: 'dup', code: '23505' } },
      { data: { id: 'x', status: 'failed', attempts: 1, updated_at: '2026-11-01T00:00:00Z' } },
      { data: [] },
    ];
    expect(await budgetAlertDeps().claim(claim)).toBe(false);
    expect(state.calls).toContainEqual(['budget_alerts', 'eq', 'status', 'failed']);
    expect(state.calls).toContainEqual(['budget_alerts', 'eq', 'attempts', 1]);
    state.calls = [];
    state.results.budget_alerts = [
      { error: { message: 'dup', code: '23505' } },
      { data: { id: 'x', status: 'failed', attempts: 2, updated_at: '2026-11-01T00:00:00Z' } },
      { data: [{ id: 'x' }] },
    ];
    expect(await budgetAlertDeps().claim(claim)).toBe(true);
  });
  it('다른 오류는 던진다', async () => {
    state.results.budget_alerts = [{ error: { message: 'relation does not exist', code: '42P01' } }];
    await expect(budgetAlertDeps().claim(claim)).rejects.toThrow('budget_alerts');
  });
  it('받는 사람은 기관 담당자 + 최상위 부서의 활성 관리자', async () => {
    state.results.organizations = [{ data: { contact_email: 'Contact@Org.kr' } }];
    state.results.departments = [{ data: [{ id: 'root' }] }];
    state.results.users = [{ data: [{ email: 'admin@org.kr' }, { email: 'contact@org.kr' }] }];
    expect(await budgetAlertDeps().recipients('org-1', 'org')).toEqual(['contact@org.kr', 'admin@org.kr']);
    expect(state.calls).toContainEqual(['departments', 'is', 'parent_id', null]);
    expect(state.calls).toContainEqual(['users', 'eq', 'role', 'ADMIN']);
    expect(state.calls).toContainEqual(['users', 'eq', 'is_active', true]);
  });
});

describe('예약 작업', () => {
  it('라우트는 CRON_SECRET으로만 열리고(없으면 503) vercel.json이 09:00 KST에 하루 한 번 부른다', () => {
    const src = readFileSync('src/app/api/cron/budget-alerts/route.ts', 'utf8');
    expect(src).toContain('timingSafeEqual');
    expect(src).toMatch(/status: 503/);
    expect(src).toMatch(/status: 401/);
    const vercel = JSON.parse(readFileSync('vercel.json', 'utf8'));
    expect(vercel.crons).toContainEqual({ path: '/api/cron/budget-alerts', schedule: '0 0 * * *' });
  });
  it('마이그레이션은 기관·기간·기준 유일 키와 RLS를 둔다', () => {
    const sql = readFileSync('supabase/migrations/0045_budget_alerts.sql', 'utf8');
    expect(sql).toContain('UNIQUE (organization_id, subject, period_key, threshold)');
    expect(sql).toContain('ENABLE ROW LEVEL SECURITY');
  });
});

describe('개인 월 한도 알림(0052)', () => {
  const user = (id: string, percent: number) => ({ userId: id, periodKey: 'month:2026-11', used: percent * 100, limit: 10_000, percent });
  const U1 = '44444444-4444-4444-8444-444444444444';
  const U2 = '55555555-5555-4555-8555-555555555555';
  it('넘은 가장 높은 기준을 그 직원 본인에게만 한 통 — 관리자 받는 사람 목록은 부르지 않는다', async () => {
    const recipients = vi.fn(async () => ['admin@org.kr']);
    const f = fakeDeps({
      status: async () => null,
      userStatuses: async () => [user(U1, 93), user(U2, 50)],
      recipients,
      person: async (_org, id) => (id === U1 ? { email: 'Kim@Org.kr', name: '김주무관' } : null),
    });
    const run = await runBudgetAlerts(f.deps);
    expect(run.sent).toBe(1);
    expect(f.claims).toEqual([{ organizationId: 'org-1', subject: `user:${U1}`, periodKey: 'month:2026-11', threshold: 90, kind: 'user_monthly', percent: 93 }]);
    expect(f.sent).toEqual([{ to: 'kim@org.kr', subject: expect.stringContaining('개인 AI 사용 한도 90% 도달') }]);
    expect(recipients).not.toHaveBeenCalled();
    expect(f.finished[0][1]).toEqual({ status: 'sent', recipients: 1 });
    expect(JSON.stringify(f.logs)).not.toContain('@org.kr');
  });
  it('그 사이 비활성·탈퇴·다른 기관이면 받을 사람 없음으로 닫고, 보내기 실패는 failed(다음 실행에 다시)', async () => {
    const gone = fakeDeps({ status: async () => null, userStatuses: async () => [user(U1, 100)], person: async () => null });
    expect((await runBudgetAlerts(gone.deps)).sent).toBe(0);
    expect(gone.finished[0][1]).toEqual({ status: 'no_recipients', recipients: 0 });
    expect(gone.sent).toEqual([]);
    const bounced = fakeDeps({ status: async () => null, userStatuses: async () => [user(U1, 100)], person: async () => ({ email: 'k@org.kr', name: null }), send: async () => ({ sent: false }) });
    expect((await runBudgetAlerts(bounced.deps)).failed).toBe(1);
    expect(bounced.finished[0][1]).toEqual({ status: 'failed', recipients: 0 });
  });
  it('개인 사용률을 못 읽어도 기관·부서 알림은 그대로 보낸다', async () => {
    const f = fakeDeps({ userStatuses: async () => { throw new Error('function does not exist'); } });
    const run = await runBudgetAlerts(f.deps);
    expect(run).toMatchObject({ sent: 1, failed: 1 });
    expect(f.logs.map((l) => l[1])).toContain('개인 한도 사용률을 확인하지 못했습니다');
  });
  it('메일은 금액·기준·내 사용현황 주소만, 이름은 이스케이프하고 제목에는 넣지 않는다', () => {
    const mail = personalBudgetAlertMail({ organizationName: '시험기관', userName: '<b>김</b>', threshold: 100, used: 10_500, limit: 10_000, percent: 105, statsUrl: 'https://x.kr/my/stats', checkedAt: new Date('2026-11-01T00:00:00Z') });
    expect(mail.subject).toContain('다음 달 1일까지 이용이 멈췄습니다');
    expect(mail.subject).not.toContain('김');
    expect(mail.html).toContain('&lt;b&gt;김&lt;/b&gt;님');
    expect(mail.html).toContain('10,500원 / 10,000원 (105%)');
    expect(mail.html).toContain('https://x.kr/my/stats');
    expect(mail.html).toContain('기관 관리자에게 개인 한도 조정을 요청');
    expect(userSubject(user(U1, 80))).toMatchObject({ subject: `user:${U1}`, kind: 'user_monthly', alertPercent: 80, departmentName: null });
  });
  it('집계는 DB 함수 한 번 — 한도가 0 이하이거나 사용액이 숫자가 아닌 행은 뺀다', async () => {
    state.rpc = [{ data: [
      { user_id: U1, limit_krw: '10000.00', spent_krw: '8123.5' },
      { user_id: U2, limit_krw: 0, spent_krw: 10 },
      { user_id: 'x', limit_krw: 100, spent_krw: 'NaN' },
    ] }];
    const statuses = await userBudgetStatuses('org-1');
    expect(statuses).toEqual([{ userId: U1, periodKey: expect.stringMatching(/^month:\d{4}-\d{2}$/), used: 8123.5, limit: 10000, percent: 81 }]);
    expect(state.calls.filter((c) => c[0] === 'rpc')).toEqual([['rpc', 'organization_user_budget_usage', expect.objectContaining({ p_organization_id: 'org-1' })]]);
    state.rpc = [{ error: { message: 'function does not exist' } }];
    await expect(userBudgetStatuses('org-1')).rejects.toThrow('organization_user_budget_usage');
  });
  it('받는 사람 확인은 같은 기관·활성·탈퇴 아님일 때만', async () => {
    const row = (over: Record<string, unknown> = {}) => ({ data: { email: 'k@org.kr', full_name: '김', is_active: true, deleted_at: null, department: { organization_id: 'org-1' }, ...over } });
    state.results.users = [row(), row({ department: { organization_id: 'org-2' } }), row({ is_active: false }), row({ deleted_at: '2026-11-01T00:00:00Z' }), row({ department: [{ organization_id: 'org-1' }] })];
    const deps = budgetAlertDeps();
    expect(await deps.person('org-1', U1)).toEqual({ email: 'k@org.kr', name: '김' });
    expect(await deps.person('org-1', U1)).toBeNull();
    expect(await deps.person('org-1', U1)).toBeNull();
    expect(await deps.person('org-1', U1)).toBeNull();
    expect(await deps.person('org-1', U1)).toEqual({ email: 'k@org.kr', name: '김' });
  });
  it('마이그레이션은 대상·종류 CHECK를 넓히고 함수 실행 권한은 service_role만', () => {
    const sql = readFileSync('supabase/migrations/0052_user_budget_alerts.sql', 'utf8');
    expect(sql).toContain("user:[0-9a-f-]{36}");
    expect(sql).toContain("'user_monthly'");
    expect(sql).toMatch(/REVOKE ALL ON FUNCTION public\.organization_user_budget_usage\(uuid, timestamptz, timestamptz\) FROM PUBLIC, anon, authenticated/);
    expect(sql).toContain('TO service_role');
    // 판정 규칙이 usage-limit.ts와 같다 — 개인 값 우선, 없으면 부서 기본값, 비용 키가 있는 로그만
    expect(sql).toContain('COALESCE(u.monthly_budget_krw, d.user_monthly_budget_krw)');
    expect(sql).toContain("ul.details ? 'cost_krw'");
  });
});
