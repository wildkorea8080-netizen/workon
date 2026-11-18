import { readFileSync } from 'fs';
import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * 2026-11-18 — 사용 한도 판정은 읽기가 실패하면 '허용'으로 연다(과금 집계 오류로 서비스가 멈추면 안 됨). 그런데
 *  ① 부서·기관·계약·부서/개인 한도 읽기 실패는 오류를 아예 보지 않아(기관 미연결·한도 없음과 구별되지 않음) 기관 정지도 건너뛰었고,
 *  ② 어디에도 남지 않아(`console.warn` 한 줄이거나 아무것도) 한도가 안 걸려도 운영자가 몰랐으며,
 *  ③ 관리자 '예산 소진 현황'은 그 '허용'을 사용 0·한도 없음으로 보였다.
 * 이제 확인하지 못한 단계를 `unverified`로 돌려주고, 운영 기록(error·payment)에 부서마다 10분에 한 번, 예산 화면은 503.
 */

type R = { data: unknown; error: unknown };
const db: { tables: Record<string, R>; rpcs: Record<string, R> } = { tables: {}, rpcs: {} };
const logs: unknown[] = [];

vi.mock('@/lib/supabaseAdmin', () => ({
  supabaseAdmin: {
    from: (t: string) => {
      const b: Record<string, unknown> = {};
      for (const n of ['select', 'eq', 'order', 'limit', 'maybeSingle', 'in', 'gte', 'lt']) b[n] = () => b;
      b.then = (ok: (v: unknown) => unknown, bad?: (e: unknown) => unknown) => Promise.resolve(db.tables[t] ?? { data: null, error: null }).then(ok, bad);
      return b;
    },
    rpc: async (fn: string) => db.rpcs[fn] ?? { data: 0, error: null },
  },
}));
vi.mock('@/lib/logger', () => ({ logSystem: async (p: unknown) => { logs.push(p); } }));

import { checkTokenLimit, reportLimitGaps, resetLimitGapReports } from '@/lib/usage-limit';

const ERR = { code: 'XX000', message: 'boom' };
const DEPT = { data: { organization_id: 'o1', monthly_budget_krw: 0, user_monthly_budget_krw: 0 }, error: null };
const ORG = { data: { name: '기관', status: 'active', monthly_token_limit: 1000 }, error: null };

beforeEach(() => {
  db.tables = { departments: DEPT, organizations: ORG, contracts: { data: null, error: null }, users: { data: null, error: null } };
  db.rpcs = { organization_chat_tokens: { data: 10, error: null } };
  logs.length = 0;
  resetLimitGapReports();
});

describe('checkTokenLimit', () => {
  it('다 읽히면 unverified 없음·기록 없음', async () => {
    const s = await checkTokenLimit('d1', 'u1');
    expect(s).toMatchObject({ allowed: true, usedTokens: 10, limitTokens: 1000 });
    expect(s.unverified).toBeUndefined();
    expect(logs).toHaveLength(0);
  });
  it('토큰 합을 못 읽으면 허용하되 tokens를 적고 운영 기록', async () => {
    db.rpcs.organization_chat_tokens = { data: null, error: ERR };
    const s = await checkTokenLimit('d1');
    expect(s.allowed).toBe(true);
    expect(s.unverified).toEqual(['tokens']);
    expect(logs).toEqual([expect.objectContaining({ level: 'error', category: 'payment', details: { department_id: 'd1', steps: ['tokens'] } })]);
  });
  it('기관을 못 읽으면 organization — 예전엔 기관 없음과 같았다(정지 확인도 건너뜀)', async () => {
    db.tables.organizations = { data: null, error: ERR };
    expect((await checkTokenLimit('d1')).unverified).toEqual(['organization']);
  });
  it('부서를 못 읽으면 department', async () => {
    db.tables.departments = { data: null, error: ERR };
    expect((await checkTokenLimit('d1')).unverified).toEqual(['department']);
  });
  it('계약을 못 읽으면 contract — 종량제 판정은 그대로 이어 감', async () => {
    db.tables.contracts = { data: null, error: ERR };
    const s = await checkTokenLimit('d1');
    expect(s.unverified).toEqual(['contract']);
    expect(s.usedTokens).toBe(10);
  });
  it('연간 정액 계약의 사용액을 못 읽으면 annual_spend', async () => {
    db.tables.organizations = { data: { name: '기관', status: 'active', monthly_token_limit: 0 }, error: null };
    db.tables.contracts = { data: { id: 'c1', billing_type: 'annual_fixed', annual_budget_krw: 1000, budget_alert_percent: 80, started_at: '2026-01-01', expires_at: null }, error: null };
    db.rpcs.organization_spend_krw = { data: null, error: ERR };
    expect((await checkTokenLimit('d1')).unverified).toEqual(['annual_spend']);
  });
  it('부서·개인 한도 사용액을 못 읽으면 적음', async () => {
    db.tables.departments = { data: { organization_id: 'o1', monthly_budget_krw: 500, user_monthly_budget_krw: 100 }, error: null };
    db.rpcs.department_spend_krw = { data: null, error: ERR };
    db.rpcs.user_spend_krw = { data: null, error: ERR };
    expect((await checkTokenLimit('d1', 'u1')).unverified).toEqual(['department_spend', 'user_spend']);
  });
  it('막힌 판정은 그대로 막고, 함께 못 읽은 단계도 적음', async () => {
    db.tables.contracts = { data: null, error: ERR };
    db.rpcs.organization_chat_tokens = { data: 1000, error: null };
    const s = await checkTokenLimit('d1');
    expect(s.allowed).toBe(false);
    expect(s.reason).toBe('token_limit_exceeded');
    expect(s.unverified).toEqual(['contract']);
  });
});

describe('reportLimitGaps', () => {
  it('부서마다 10분에 한 번', async () => {
    const log = vi.fn(async () => {});
    const t = Date.parse('2026-11-18T01:00:00Z');
    expect(await reportLimitGaps('d1', ['tokens'], log, t)).toBe(true);
    expect(await reportLimitGaps('d1', ['tokens'], log, t + 9 * 60_000)).toBe(false);
    expect(await reportLimitGaps('d2', ['tokens'], log, t + 60_000)).toBe(true);
    expect(await reportLimitGaps('d1', ['tokens'], log, t + 10 * 60_000)).toBe(true);
    expect(await reportLimitGaps('d3', [], log, t)).toBe(false);
    expect(log).toHaveBeenCalledTimes(3);
  });
  it('운영 기록이 실패해도 던지지 않음', async () => {
    await expect(reportLimitGaps('d9', ['tokens'], async () => { throw new Error('x'); })).resolves.toBe(true);
  });
});

describe('관리자 예산 화면', () => {
  const s = readFileSync('src/app/api/admin/budget/route.ts', 'utf8');
  it('한도를 확인하지 못했으면 503 — 사용 0으로 보이지 않음', () => {
    expect(s).toContain('if (status.unverified) return unavailable();');
    expect(s).toMatch(/function unavailable\(\) \{[\s\S]*?status: 503/);
  });
  it('부서·계약 읽기 실패도 503', () => {
    expect(s).toContain('if (deptError) return unavailable();');
    expect(s).toContain('if (contractError) return unavailable();');
  });
  it('화면은 카드를 조용히 감추지 않고 안내', () => {
    const ui = readFileSync('src/components/admin/OrganizationManager.tsx', 'utf8');
    expect(ui).toContain("else setBudgetError(budgetRes.error?.message ?? '예산 현황을 불러오지 못했습니다.');");
    expect(ui).toContain('{!budget && budgetError && (');
  });
});
