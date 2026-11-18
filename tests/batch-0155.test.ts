import { readFileSync } from 'fs';
import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * 2026-11-18 — 개인 월 한도 알림 메일의 단추가 '내 사용현황 보기'인데 그 화면에 한도·사용액이 없었다
 * (한도에 닿아 막힌 직원이 얼마를 썼고 한도가 얼마인지 볼 곳이 없음). 이제 판정(`checkMonthlyBudget`)과 같은 규칙으로 보인다.
 */

type R = { data: unknown; error: unknown };
const db: { tables: Record<string, R>; rpcs: Record<string, R>; rpcArgs: unknown[] } = { tables: {}, rpcs: {}, rpcArgs: [] };

vi.mock('@/lib/supabaseAdmin', () => ({
  supabaseAdmin: {
    from: (t: string) => {
      const b: Record<string, unknown> = {};
      for (const n of ['select', 'eq', 'maybeSingle']) b[n] = () => b;
      b.then = (ok: (v: unknown) => unknown, bad?: (e: unknown) => unknown) => Promise.resolve(db.tables[t] ?? { data: null, error: null }).then(ok, bad);
      return b;
    },
    rpc: async (fn: string, args: unknown) => { db.rpcArgs.push([fn, args]); return db.rpcs[fn] ?? { data: 0, error: null }; },
  },
}));
vi.mock('@/lib/logger', () => ({ logSystem: async () => {} }));

import { myMonthlyBudget } from '@/lib/usage-limit';

const ERR = { code: 'XX000', message: 'boom' };

beforeEach(() => {
  db.tables = {
    users: { data: { department_id: 'd1', monthly_budget_krw: null }, error: null },
    departments: { data: { user_monthly_budget_krw: 10000 }, error: null },
  };
  db.rpcs = { user_spend_krw: { data: '8123.5', error: null } };
  db.rpcArgs = [];
});

describe('myMonthlyBudget', () => {
  it('개인 값이 없으면 부서 기본값 — 사용액은 user_spend_krw', async () => {
    expect(await myMonthlyBudget('u1')).toEqual({ usedKrw: 8123.5, limitKrw: 10000, percent: 81, exhausted: false });
    expect(db.rpcArgs[0]).toEqual(['user_spend_krw', expect.objectContaining({ p_user_id: 'u1' })]);
  });
  it('개인 값이 있으면 그 값이 우선', async () => {
    db.tables.users = { data: { department_id: 'd1', monthly_budget_krw: 5000 }, error: null };
    expect(await myMonthlyBudget('u1')).toMatchObject({ limitKrw: 5000, percent: 162, exhausted: true });
  });
  it('한도와 같으면 막힌 것(판정과 같은 >=), 99.6%는 100%로 보이지 않음', async () => {
    db.rpcs.user_spend_krw = { data: 10000, error: null };
    expect(await myMonthlyBudget('u1')).toMatchObject({ percent: 100, exhausted: true });
    db.rpcs.user_spend_krw = { data: 9960, error: null };
    expect(await myMonthlyBudget('u1')).toMatchObject({ percent: 99, exhausted: false });
  });
  it('한도가 없으면 null — 사용액을 읽지도 않음', async () => {
    db.tables.departments = { data: { user_monthly_budget_krw: null }, error: null };
    expect(await myMonthlyBudget('u1')).toBeNull();
    db.tables.users = { data: { department_id: 'd1', monthly_budget_krw: 0 }, error: null };
    db.tables.departments = { data: { user_monthly_budget_krw: 10000 }, error: null };
    expect(await myMonthlyBudget('u1')).toBeNull(); // 개인 값 0 = 한도 없음(판정과 같음)
    expect(db.rpcArgs).toHaveLength(0);
  });
  it.each([
    ['users', () => { db.tables.users = { data: null, error: ERR }; }],
    ['departments', () => { db.tables.departments = { data: null, error: ERR }; }],
    ['user_spend_krw', () => { db.rpcs.user_spend_krw = { data: null, error: ERR }; }],
    ['숫자 아님', () => { db.rpcs.user_spend_krw = { data: 'x', error: null }; }],
  ])('%s를 못 읽으면 던짐 — 0원으로 꾸미지 않음', async (_n, breakIt) => {
    breakIt();
    await expect(myMonthlyBudget('u1')).rejects.toBeTruthy();
  });
});

describe('원본', () => {
  const route = readFileSync('src/app/api/my/stats/route.ts', 'utf8');
  const ui = readFileSync('src/app/my/stats/page.tsx', 'utf8');
  it('라우트는 못 읽으면 budgetUnknown — 통계 전체를 막지 않음', () => {
    expect(route).toMatch(/try \{\s*budget = await myMonthlyBudget\(userId\);\s*\} catch \{\s*budgetUnknown = true;/);
    expect(route).toMatch(/streakDays,\s*budget,\s*budgetUnknown,/);
  });
  it('화면은 한도·사용액·멈춤 안내를 보이고, 못 읽었으면 그렇게 말함', () => {
    expect(ui).toContain('이번 달 개인 한도');
    expect(ui).toContain('{!loading && data?.summary.budget && <BudgetCard budget={data.summary.budget} />}');
    expect(ui).toContain('한도에 닿아 다음 달 1일까지 이용이 멈췄습니다.');
    expect(ui).toContain('이번 달 개인 한도 사용액을 지금 확인하지 못했습니다.');
  });
  it('판정과 같은 규칙 — 개인 값 우선·부서 기본값', () => {
    const lib = readFileSync('src/lib/usage-limit.ts', 'utf8');
    expect(lib).toContain('Number(user.monthly_budget_krw ?? dept?.user_monthly_budget_krw ?? 0)');
    expect(lib).toContain('Number(user?.monthly_budget_krw ?? dept.user_monthly_budget_krw ?? 0)');
  });
});
