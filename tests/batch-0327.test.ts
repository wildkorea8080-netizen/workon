// tests/batch-0327.test.ts
// 예산 알림 이력(2026-11-26, 마이그레이션 없음) — 관리자가 예산 알림 메일을 보냈는지(보냄·받는 사람 없음·못 보냄) 본다.
import { readFileSync } from 'fs';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const state: { alerts: unknown[]; alertError: unknown; depts: unknown[]; deptError: unknown; calls: string[] } = { alerts: [], alertError: null, depts: [], deptError: null, calls: [] };
vi.mock('@/lib/supabaseAdmin', () => ({
  supabaseAdmin: {
    from(table: string) {
      const b: Record<string, unknown> = {};
      for (const m of ['select', 'eq', 'not', 'order', 'limit', 'in']) b[m] = (...args: unknown[]) => { state.calls.push(`${table}.${m}:${JSON.stringify(args)}`); return b; };
      b.then = (res: (v: unknown) => unknown) => res(table === 'budget_alerts' ? { data: state.alerts, error: state.alertError } : { data: state.depts, error: state.deptError });
      b.maybeSingle = async () => ({ data: { budget_alert_emails: [] }, error: null });
      return b;
    },
  },
}));
vi.mock('@/lib/auth', () => ({ getServerAuthSession: vi.fn(async () => ({ user: { id: 'u1', role: 'ADMIN' } })), isAdminSession: (s: { user?: { role?: string } }) => s?.user?.role === 'ADMIN' }));
const D1 = 'aaaaaaaa-0000-4000-8000-000000000001';
const D2 = 'aaaaaaaa-0000-4000-8000-000000000002';
vi.mock('@/lib/actor-scope-response', () => ({ actorScopeOr503: vi.fn(async () => ({ userId: 'u1', organizationId: 'o1', managedDepartmentIds: [D1], managesWholeOrganization: false })) }));
vi.mock('@/lib/mailer', () => ({ isMailConfigured: () => true }));

import { GET } from '@/app/api/admin/budget-alerts/route';
import { BUDGET_ALERT_HISTORY_ATTEMPTS, budgetAlertStatusLabel, budgetAlertView, budgetPeriodLabel, visibleAlertTarget } from '@/lib/budget-alert-history-spec';
import { MAX_ALERT_ATTEMPTS } from '@/lib/budget-alerts';
import { API_ROUTES } from '@/lib/api-route-ids';

const row = (over: Record<string, unknown> = {}) => ({ id: 'r1', subject: 'org', period_key: 'month:2026-11', threshold: 80, kind: 'monthly_tokens', status: 'sent', attempts: 1, percent: 83, recipients: 2, created_at: '2026-11-26T00:00:00Z', updated_at: '2026-11-26T00:00:00Z', ...over });

describe('꼴', () => {
  it('기관은 누구나, 부서는 관리 범위만, 개인·모르는 꼴은 아님', () => {
    const managed = new Set([D1]);
    expect(visibleAlertTarget('org', managed)).toEqual({ target: 'organization', departmentId: null });
    expect(visibleAlertTarget(`dept:${D1.toUpperCase()}`, managed)).toEqual({ target: 'department', departmentId: D1 });
    expect(visibleAlertTarget(`dept:${D2}`, managed)).toBeNull();
    expect(visibleAlertTarget(`user:${D1}`, managed)).toBeNull();
  });
  it('기간·상태 글, 해 보는 횟수는 보내는 쪽과 같다', () => {
    expect(budgetPeriodLabel('month:2026-03')).toBe('2026년 3월');
    expect(budgetPeriodLabel(`contract:${D1}`)).toBe('계약 기간');
    expect(BUDGET_ALERT_HISTORY_ATTEMPTS).toBe(MAX_ALERT_ATTEMPTS);
    expect(budgetAlertStatusLabel('failed', 1)).toContain('다음 확인 때 다시');
    expect(budgetAlertStatusLabel('failed', 3)).toContain('더 해 보지 않음');
    expect(budgetAlertStatusLabel('no_recipients', 1)).toContain('받는 사람 없음');
    expect(budgetAlertView(row({ subject: `dept:${D1}`, kind: 'department_monthly' }), new Set([D1]), new Map([[D1, '총무과']]))).toMatchObject({ target: 'department', departmentName: '총무과', kindLabel: '부서 월 한도', periodLabel: '2026년 11월', statusLabel: '보냄' });
  });
});

describe('라우트', () => {
  beforeEach(() => { state.alerts = []; state.alertError = null; state.depts = []; state.deptError = null; state.calls = []; });
  it('이 기관 것만·개인 알림은 묻지 않고, 관리 범위 밖 부서는 빼고, 부서 이름을 붙인다', async () => {
    state.alerts = [row(), row({ id: 'r2', subject: `dept:${D1}`, kind: 'department_monthly', status: 'no_recipients', recipients: 0 }), row({ id: 'r3', subject: `dept:${D2}` })];
    state.depts = [{ id: D1, name: '총무과' }];
    const res = await GET();
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.mailConfigured).toBe(true);
    expect(body.data.alerts.map((a: { id: string }) => a.id)).toEqual(['r1', 'r2']);
    expect(body.data.alerts[1]).toMatchObject({ departmentName: '총무과', statusLabel: '받는 사람 없음 — 보내지 않음' });
    expect(state.calls).toContain('budget_alerts.eq:["organization_id","o1"]');
    expect(state.calls).toContain('budget_alerts.not:["subject","like","user:%"]');
    expect(state.calls.some((c) => c.startsWith('departments.in') && !c.includes(D2))).toBe(true);
  });
  it('못 읽으면 빈 이력이 아니라 503(이력·부서 이름 둘 다)', async () => {
    state.alertError = { code: 'x' };
    expect((await GET()).status).toBe(503);
    state.alertError = null;
    state.alerts = [row({ subject: `dept:${D1}` })];
    state.deptError = { code: 'x' };
    expect((await GET()).status).toBe(503);
  });
  it('연결 — 라우트 목록·기관 정보 화면', () => {
    expect(API_ROUTES).toContain('admin/budget-alerts');
    expect(readFileSync('src/app/admin/organization/page.tsx', 'utf8')).toContain('<BudgetAlertsPanel />');
    expect(readFileSync('src/components/admin/BudgetAlertsPanel.tsx', 'utf8')).toContain("if (r.status === 401 || r.status === 403) setHidden(true); else setUnread(true);");
  });
});
