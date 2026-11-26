// tests/batch-0332.test.ts
// 기관 예산 알림을 더 받을 주소(2026-11-26, 0135) — 기관 전체 관리자가 5개까지, 기관 알림에만 더한다.
import { readFileSync } from 'fs';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({ org: { contact_email: 'contact@agency.go.kr', budget_alert_emails: ['Budget@Agency.go.kr'] } as Record<string, unknown>, updated: null as unknown, whole: true, impersonating: false, logs: [] as unknown[] }));
vi.mock('@/lib/supabaseAdmin', () => ({
  supabaseAdmin: {
    from(table: string) {
      const b: Record<string, unknown> = {};
      for (const m of ['select', 'eq', 'is', 'in', 'not', 'order', 'limit']) b[m] = () => b;
      b.update = (v: unknown) => { state.updated = v; return b; };
      b.maybeSingle = async () => ({ data: state.org, error: null });
      b.then = (res: (v: unknown) => unknown) => res(table === 'departments' ? { data: [{ id: 'root' }], error: null } : table === 'users' ? { data: [{ email: 'admin@agency.go.kr' }], error: null } : table === 'organizations' ? { data: [{ budget_alert_emails: [] }], error: null } : { data: [], error: null });
      return b;
    },
    rpc: async () => ({ data: [], error: null }),
  },
}));
vi.mock('@/lib/auth', () => ({ getServerAuthSession: async () => ({ user: { id: 'u1', role: 'ADMIN', isImpersonating: state.impersonating } }), isAdminSession: () => true }));
vi.mock('@/lib/actor-scope-response', () => ({ actorScopeOr503: async () => ({ userId: 'u1', organizationId: 'o1', departmentId: 'root', managedDepartmentIds: ['root'], managesWholeOrganization: state.whole }) }));
vi.mock('@/lib/security-log', () => ({ logSecurityEvent: async (...a: unknown[]) => { state.logs.push(a); } }));

import { PUT } from '@/app/api/admin/budget-alerts/route';
import { parseBudgetAlertEmails } from '@/lib/budget-alert-history-spec';
import { budgetAlertDeps } from '@/lib/budget-alerts';

const put = (body: unknown) => PUT(new Request('https://workon.test/api/admin/budget-alerts', { method: 'PUT', body: JSON.stringify(body) }));
beforeEach(() => { state.updated = null; state.whole = true; state.impersonating = false; state.logs = []; });

describe('더 받을 주소', () => {
  it('검사 — 다듬기·겹침 없이·꼴·5개', () => {
    expect(parseBudgetAlertEmails([' A@b.kr ', 'a@b.kr'])).toEqual({ ok: true, emails: ['a@b.kr'] });
    expect(parseBudgetAlertEmails(['x'])).toMatchObject({ ok: false });
    expect(parseBudgetAlertEmails(Array.from({ length: 6 }, (_, i) => `p${i}@b.kr`))).toMatchObject({ ok: false });
    expect(parseBudgetAlertEmails('a@b.kr')).toMatchObject({ ok: false });
  });
  it('저장 — 기관 전체 관리자만, 대리 접근 403, 보안 로그는 수만', async () => {
    expect((await put({ emails: ['budget@agency.go.kr'] })).status).toBe(200);
    expect(state.updated).toEqual({ budget_alert_emails: ['budget@agency.go.kr'] });
    expect(state.logs[0]).toEqual(['root', 'u1', 'budget_alert_recipients_changed', { count: 1 }, 'medium']);
    state.whole = false;
    expect((await put({ emails: [] })).status).toBe(403);
    state.whole = true; state.impersonating = true;
    expect((await put({ emails: [] })).status).toBe(403);
    state.impersonating = false;
    expect((await put({ emails: ['nope'] })).status).toBe(400);
  });
  it('기관 알림의 받는 사람에 더한다', async () => {
    expect(await budgetAlertDeps().recipients('o1', 'org')).toEqual(['contact@agency.go.kr', 'budget@agency.go.kr', 'admin@agency.go.kr']);
    expect(readFileSync('src/components/admin/BudgetAlertsPanel.tsx', 'utf8')).toContain('aria-label="예산 알림 더 받을 주소"');
  });
});
