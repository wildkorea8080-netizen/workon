import { readFileSync } from 'fs';
import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * 2026-11-19 — 계약 바꾸기(갱신·해지, `PATCH /api/super/contracts/[id]`).
 * 예전: 표 밖 요금제를 체험 한도로 기관에 넣음, 틀린 날짜는 500, 1억 원 넘는 이용료·소수 경고 비율은 DB 거절로 500,
 * 이미 끝난 계약을 다시 해지해도 기관을 정지, 끝난 옛 계약의 요금제를 바꿔도 기관 한도를 덮음, 계약 행의 한도는 그대로,
 * 대상이 없으면 500. 갱신 창은 메모를 비워 두면 있던 메모를 빈 글로 지웠다.
 */

type Chain = { table: string; ops: Array<[string, unknown[]]> };
const state = {
  chains: [] as Chain[],
  before: { id: 'c1', organization_id: 'o1', status: 'active', plan: 'basic', started_at: '2026-01-01T00:00:00Z', price_per_month: 100 } as Record<string, unknown> | null,
  beforeError: null as unknown,
};
const has = (c: Chain, op: string) => c.ops.some(([k]) => k === op);
const arg = (c: Chain, op: string) => c.ops.find(([k]) => k === op)?.[1];

vi.mock('@/lib/super-auth', () => ({ getSuperAdminFromRequest: () => ({ sub: 'sa' }) }));
vi.mock('@/lib/audit-write', () => ({ writeAuditRow: vi.fn(async () => true) }));
vi.mock('@/lib/contract-sync', () => ({ reportContractSync: async () => '경고' }));
vi.mock('@/lib/supabaseAdmin', () => ({
  supabaseAdmin: {
    from: (table: string) => {
      const chain: Chain = { table, ops: [] };
      state.chains.push(chain);
      const b: Record<string, unknown> = {};
      for (const n of ['select', 'eq', 'update']) b[n] = (...a: unknown[]) => { chain.ops.push([n, a]); return b; };
      const respond = () => {
        if (table === 'contracts' && has(chain, 'update')) return { data: state.before ? { ...state.before, ...(arg(chain, 'update')![0] as object) } : null, error: null };
        if (table === 'contracts') return { data: state.before, error: state.beforeError };
        return { data: null, error: null };
      };
      b.maybeSingle = async () => respond();
      b.then = (res: (v: unknown) => unknown) => Promise.resolve(respond()).then(res);
      return b;
    },
  },
}));

import { MAX_MONTHLY_FEE, parseContractInput, parseContractPatch } from '@/lib/contract-input';
import { PATCH } from '@/app/api/super/contracts/[id]/route';

const patch = (body: unknown) => PATCH(new Request('http://x/', {
  method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: typeof body === 'string' ? body : JSON.stringify(body),
}) as never, { params: { id: 'c1' } });
const updatesOf = (t: string) => state.chains.filter((c) => c.table === t && has(c, 'update')).map((c) => arg(c, 'update')![0] as Record<string, unknown>);

beforeEach(() => {
  state.chains = [];
  state.before = { id: 'c1', organization_id: 'o1', status: 'active', plan: 'basic', started_at: '2026-01-01T00:00:00Z', price_per_month: 100 };
  state.beforeError = null;
});

describe('parseContractPatch', () => {
  it('틀린 값은 거절', () => {
    for (const b of [
      null, {}, { status: 'active' }, { planType: 'gold' }, { monthlyFee: -1 }, { monthlyFee: 1.5 }, { monthlyFee: 'abc' },
      { monthlyFee: MAX_MONTHLY_FEE + 1 }, { endDate: '2026-02-30' }, { endDate: 'tomorrow' }, { notes: 'x'.repeat(1001) },
      { billingType: 'monthly' }, { budgetAlertPercent: 80.5 }, { budgetAlertPercent: 0 }, { annualBudgetKrw: 1e13 },
    ]) expect(parseContractPatch(b).ok).toBe(false);
  });
  it('온 칸만 담고, 빈 종료일은 바꾸지 않음·빈 메모는 지움', () => {
    expect(parseContractPatch({ planType: 'pro', monthlyFee: '300000', endDate: '', notes: '' }))
      .toEqual({ ok: true, value: { planType: 'pro', monthlyFee: 300000, notes: null } });
  });
  it('새 계약도 1억 원 넘는 이용료를 받지 않는다(price_per_month numeric(10,2))', () => {
    expect(MAX_MONTHLY_FEE).toBeLessThan(100_000_000);
    expect(parseContractInput({ orgId: '11111111-1111-1111-1111-111111111111', planType: 'basic', monthlyFee: 100_000_000 }).ok).toBe(false);
  });
});

describe('PATCH /api/super/contracts/[id]', () => {
  it('틀린 입력은 400 — DB를 부르지 않음', async () => {
    for (const b of [{ planType: 'gold' }, { endDate: 'x' }, '{깨짐']) {
      state.chains = [];
      expect((await patch(b)).status).toBe(400);
      expect(state.chains).toHaveLength(0);
    }
  });

  it('계약을 못 읽으면 503, 없으면 404 — 바꾸지 않음', async () => {
    state.beforeError = { code: 'XX000' };
    expect((await patch({ monthlyFee: 1 })).status).toBe(503);
    state.beforeError = null; state.before = null;
    expect((await patch({ monthlyFee: 1 })).status).toBe(404);
    expect(updatesOf('contracts')).toHaveLength(0);
  });

  it('이미 끝난 계약을 다시 해지하면 409 — 기관을 정지하지 않음', async () => {
    state.before = { ...state.before!, status: 'cancelled' };
    expect((await patch({ status: 'cancelled' })).status).toBe(409);
    expect(updatesOf('organizations')).toHaveLength(0);
  });

  it('살아 있는 계약 해지는 기관을 정지', async () => {
    expect((await patch({ status: 'cancelled' })).status).toBe(200);
    expect(updatesOf('organizations')).toEqual([{ status: 'suspended' }]);
  });

  it('종료일이 시작일보다 앞서면 400', async () => {
    expect((await patch({ endDate: '2025-12-31' })).status).toBe(400);
    expect(updatesOf('contracts')).toHaveLength(0);
  });

  it('지금 계약의 요금제를 바꾸면 계약 행·기관 한도를 함께 맞춘다', async () => {
    expect((await patch({ planType: 'pro' })).status).toBe(200);
    const [c] = updatesOf('contracts');
    expect(c).toMatchObject({ plan: 'pro', max_users: expect.any(Number), max_agents: expect.any(Number), monthly_token_limit: expect.any(Number) });
    expect(updatesOf('organizations')[0]).toMatchObject({ plan: 'pro' });
  });

  it('끝난 옛 계약의 요금제를 고쳐도 기관 한도는 그대로', async () => {
    state.before = { ...state.before!, status: 'expired' };
    expect((await patch({ planType: 'enterprise' })).status).toBe(200);
    expect(updatesOf('organizations')).toHaveLength(0);
  });

  it('메모를 보내지 않으면 메모 칸을 건드리지 않는다', async () => {
    await patch({ monthlyFee: 5 });
    expect(updatesOf('contracts')[0]).not.toHaveProperty('notes');
  });
});

describe('원본 확인 — 갱신 창', () => {
  const src = readFileSync('src/app/super/contracts/page.tsx', 'utf8');
  it('빈 메모는 보내지 않고 실패를 보인다', () => {
    const h = src.slice(src.indexOf('function RenewModal'), src.indexOf('return (', src.indexOf('function RenewModal')));
    expect(h).toContain("notes.trim() ? { notes: notes.trim() } : {}");
    expect(h).toContain('res.ok && d?.ok');
    expect(h).toContain('finally');
  });
});
