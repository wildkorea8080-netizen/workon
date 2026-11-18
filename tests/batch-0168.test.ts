import { readFileSync } from 'fs';
import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * 2026-11-18 — 내 사용현황(`/my/stats`)에 **부서 월 한도**가 없었다. 부서 한도는 판정에서 가장 먼저 보고 닿으면 그 부서 직원 전체가 멈추는데,
 * 닿기 전에는 얼마나 남았는지, 닿은 뒤에는 얼마를 썼는지 직원이 볼 곳이 없었다(개인 한도는 0155에서 넣었다).
 */

type R = { data: unknown; error: unknown };
const db: { tables: Record<string, R>; rpcs: Record<string, R>; rpcArgs: Array<[string, Record<string, unknown>]>; selects: Array<[string, unknown]> } = {
  tables: {}, rpcs: {}, rpcArgs: [], selects: [],
};

vi.mock('@/lib/supabaseAdmin', () => ({
  supabaseAdmin: {
    from: (t: string) => {
      const b: Record<string, unknown> = {};
      b.select = (cols: unknown) => { db.selects.push([t, cols]); return b; };
      for (const n of ['eq', 'maybeSingle']) b[n] = () => b;
      b.then = (ok: (v: unknown) => unknown, bad?: (e: unknown) => unknown) => Promise.resolve(db.tables[t] ?? { data: null, error: null }).then(ok, bad);
      return b;
    },
    rpc: async (fn: string, args: Record<string, unknown>) => { db.rpcArgs.push([fn, args]); return db.rpcs[fn] ?? { data: 0, error: null }; },
  },
}));
vi.mock('@/lib/logger', () => ({ logSystem: async () => {} }));

import { myDepartmentBudget } from '@/lib/usage-limit';

const ERR = { code: 'XX000', message: 'boom' };

beforeEach(() => {
  db.tables = {
    users: { data: { department_id: 'd1' }, error: null },
    departments: { data: { monthly_budget_krw: 200000 }, error: null },
  };
  db.rpcs = { department_spend_krw: { data: '163000.4', error: null } };
  db.rpcArgs = [];
  db.selects = [];
});

describe('myDepartmentBudget — 판정과 같은 규칙', () => {
  it('내 부서의 한도와 이번 달(한국 시간) 부서 사용액', async () => {
    expect(await myDepartmentBudget('u1')).toEqual({ usedKrw: 163000.4, limitKrw: 200000, percent: 81, exhausted: false });
    expect(db.rpcArgs).toHaveLength(1);
    const [fn, args] = db.rpcArgs[0];
    expect(fn).toBe('department_spend_krw');
    expect(args.p_department_id).toBe('d1');
    // 이번 달 1일 00:00 한국 시간 = 전날 15:00 UTC
    expect(String(args.p_from)).toMatch(/T15:00:00\.000Z$/);
    // 부서 전체의 합계만 — 직원별 값은 읽지 않는다
    expect(db.rpcArgs.some(([name]) => name === 'user_spend_krw')).toBe(false);
  });

  it('닿았으면(>=) 멈춘 상태, 퍼센트는 내림', async () => {
    db.rpcs.department_spend_krw = { data: 200000, error: null };
    expect(await myDepartmentBudget('u1')).toMatchObject({ percent: 100, exhausted: true });
    db.rpcs.department_spend_krw = { data: 199999, error: null };
    expect(await myDepartmentBudget('u1')).toMatchObject({ percent: 99, exhausted: false });
    db.rpcs.department_spend_krw = { data: 350000, error: null };
    expect(await myDepartmentBudget('u1')).toMatchObject({ percent: 175, exhausted: true });
  });

  it('부서 한도가 없으면(비었거나 0) null — 사용액을 세지도 않는다', async () => {
    db.tables.departments = { data: { monthly_budget_krw: null }, error: null };
    expect(await myDepartmentBudget('u1')).toBeNull();
    db.tables.departments = { data: { monthly_budget_krw: 0 }, error: null };
    expect(await myDepartmentBudget('u1')).toBeNull();
    db.tables.users = { data: { department_id: null }, error: null };
    expect(await myDepartmentBudget('u1')).toBeNull();
    expect(db.rpcArgs).toHaveLength(0);
  });

  it('못 읽으면 0원으로 꾸미지 않고 던진다 — 직원·부서·사용액 어느 것이든', async () => {
    db.tables.users = { data: null, error: ERR };
    await expect(myDepartmentBudget('u1')).rejects.toBeTruthy();

    db.tables.users = { data: { department_id: 'd1' }, error: null };
    db.tables.departments = { data: null, error: ERR };
    await expect(myDepartmentBudget('u1')).rejects.toBeTruthy();

    db.tables.departments = { data: { monthly_budget_krw: 200000 }, error: null };
    db.rpcs.department_spend_krw = { data: null, error: ERR };
    await expect(myDepartmentBudget('u1')).rejects.toBeTruthy();

    db.rpcs.department_spend_krw = { data: 'abc', error: null };
    await expect(myDepartmentBudget('u1')).rejects.toBeTruthy();
  });
});

describe('라우트·화면', () => {
  const route = readFileSync('src/app/api/my/stats/route.ts', 'utf8');
  const page = readFileSync('src/app/my/stats/page.tsx', 'utf8');
  const lib = readFileSync('src/lib/usage-limit.ts', 'utf8');

  it('라우트는 세션 본인으로 읽고, 못 읽으면 departmentBudgetUnknown — 통계 전체를 막지 않는다', () => {
    expect(route).toMatch(/try \{\s*departmentBudget = await myDepartmentBudget\(userId\);\s*\} catch \{\s*departmentBudgetUnknown = true;/);
    expect(route).toMatch(/budgetUnknown,\s*departmentBudget,\s*departmentBudgetUnknown,/);
  });

  it('화면은 부서 한도 카드를 개인 한도와 따로 보이고, 부서 전체가 멈춘다는 것을 밝힌다', () => {
    expect(page).toContain('<BudgetCard budget={data.summary.departmentBudget} scope="department" />');
    expect(page).toContain("scope === 'department' ? '이번 달 부서 한도' : '이번 달 개인 한도'");
    expect(page).toContain('부서 전체의 이용이 멈춥니다');
    expect(page).toContain('이번 달 부서 한도 사용액을 지금 확인하지 못했습니다');
    // 개인 한도 카드는 그대로
    expect(page).toContain('{!loading && data?.summary.budget && <BudgetCard budget={data.summary.budget} />}');
  });

  it('판정(checkMonthlyBudget)과 같은 칸·같은 함수·같은 달 시작을 쓴다', () => {
    const fn = lib.slice(lib.indexOf('export async function myDepartmentBudget'), lib.indexOf('export interface UserBudgetStatus'));
    expect(fn).toContain("rpc('department_spend_krw'");
    expect(fn).toContain('p_from: monthStartISO()');
    expect(fn).toContain("select('monthly_budget_krw')");
    expect(fn).toContain('exhausted: usedKrw >= limitKrw');
  });
});
