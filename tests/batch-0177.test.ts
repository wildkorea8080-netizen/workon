import { readFileSync } from 'fs';
import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * 2026-11-19 — 슈퍼관리자 기관 상세의 '계약 수정 / 새 계약'과 계약 만들기 입력.
 * - 기관 상세의 창은 시작일·종료일·이용료를 받고도 **기관의 요금제 이름만** 바꾸고 '계약이 업데이트됐습니다'라고 알렸다
 *   (계약은 그대로·한도도 그대로, 응답도 보지 않음)
 * - 계약 만들기는 표 밖 요금제를 체험(trial) 한도로 조용히 저장했고, 이용료·날짜의 꼴을 보지 않았다.
 *   틀린 요청이어도 **지금 계약을 먼저 끝냈다**
 */

type Call = { table: string; ops: Array<[string, unknown[]]> };
const state: { admin: unknown; calls: Call[] } = { admin: null, calls: [] };
const did = (c: Call, name: string) => c.ops.some(([n]) => n === name);

vi.mock('@/lib/super-auth', () => ({ getSuperAdminFromRequest: () => state.admin }));
vi.mock('@/lib/audit-write', () => ({ writeAuditRow: async () => true }));
vi.mock('@/lib/contract-sync', () => ({ reportContractSync: async () => '경고' }));
vi.mock('@/lib/supabaseAdmin', () => ({
  supabaseAdmin: {
    from: (table: string) => {
      const call: Call = { table, ops: [] };
      state.calls.push(call);
      const b: Record<string, unknown> = {};
      for (const n of ['select', 'eq', 'in', 'update', 'insert']) b[n] = (...args: unknown[]) => { call.ops.push([n, args]); return b; };
      b.single = async () => ({ data: { id: 'k1', organization_id: ORG, plan: 'basic' }, error: null });
      b.then = (res: (v: unknown) => unknown) => Promise.resolve({ data: null, error: null }).then(res);
      return b;
    },
  },
}));

const ORG = '11111111-1111-4111-8111-111111111111';
import { parseContractInput, validDay } from '@/lib/contract-input';
import { POST } from '@/app/api/super/contracts/route';

const post = (body: unknown) => POST(new Request('http://x/api/super/contracts', {
  method: 'POST', headers: { 'Content-Type': 'application/json' }, body: typeof body === 'string' ? body : JSON.stringify(body),
}) as never);

beforeEach(() => { state.admin = { sub: 'a1' }; state.calls = []; });

describe('parseContractInput', () => {
  const base = { orgId: ORG, planType: 'basic' };
  it('요금제 기본 이용료·기본 값', () => {
    const r = parseContractInput(base);
    expect(r).toEqual({ ok: true, value: expect.objectContaining({ planType: 'basic', monthlyFee: 100_000, startDate: null, endDate: null, notes: null, billingType: 'pay_as_you_go', annualBudgetKrw: null, budgetAlertPercent: 80 }) });
  });
  it('표 밖 요금제·기관 id가 아님은 거절(예전엔 체험 한도로 저장)', () => {
    expect(parseContractInput({ ...base, planType: 'gold' }).ok).toBe(false);
    expect(parseContractInput({ ...base, planType: 'toString' }).ok).toBe(false);
    expect(parseContractInput({ ...base, orgId: 'x' }).ok).toBe(false);
    expect(parseContractInput(null).ok).toBe(false);
  });
  it('이용료는 0 이상의 정수', () => {
    expect(parseContractInput({ ...base, monthlyFee: 0 })).toMatchObject({ ok: true, value: { monthlyFee: 0 } });
    expect(parseContractInput({ ...base, monthlyFee: '250000' })).toMatchObject({ ok: true, value: { monthlyFee: 250000 } });
    for (const fee of [-1, 1.5, 'abc', 2_000_000_000]) expect(parseContractInput({ ...base, monthlyFee: fee }).ok).toBe(false);
  });
  it('날짜는 있는 날이고 종료일이 시작일보다 앞서지 않음', () => {
    expect(validDay('2026-02-29')).toBeNull();
    expect(validDay('2028-02-29')).toBe('2028-02-29');
    expect(validDay('2026-1-5')).toBeNull();
    expect(parseContractInput({ ...base, startDate: '2026-11-19', endDate: '2027-11-18' })).toMatchObject({ ok: true, value: { startDate: '2026-11-19', endDate: '2027-11-18' } });
    expect(parseContractInput({ ...base, startDate: '2026-11-19', endDate: '2026-11-01' }).ok).toBe(false);
    expect(parseContractInput({ ...base, startDate: '2026-13-01' }).ok).toBe(false);
    expect(parseContractInput({ ...base, endDate: '' })).toMatchObject({ ok: true, value: { endDate: null } });
  });
  it('연간 정액 — 예산이 있으면 정수, 0·빈 값은 없음', () => {
    expect(parseContractInput({ ...base, billingType: 'annual_fixed', annualBudgetKrw: 12_000_000 })).toMatchObject({ ok: true, value: { billingType: 'annual_fixed', annualBudgetKrw: 12_000_000 } });
    expect(parseContractInput({ ...base, billingType: 'annual_fixed', annualBudgetKrw: 0 })).toMatchObject({ ok: true, value: { annualBudgetKrw: null } });
    expect(parseContractInput({ ...base, billingType: 'annual_fixed', annualBudgetKrw: 'x' }).ok).toBe(false);
    expect(parseContractInput({ ...base, annualBudgetKrw: 5 })).toMatchObject({ ok: true, value: { annualBudgetKrw: null } });
  });
});

describe('POST /api/super/contracts', () => {
  it('틀린 입력은 400 — 지금 계약을 끝내지 않는다(DB를 부르지 않음)', async () => {
    for (const body of [{ orgId: ORG, planType: 'gold' }, { orgId: ORG, planType: 'basic', monthlyFee: -5 }, '{깨짐']) {
      state.calls = [];
      const res = await post(body);
      expect(res.status).toBe(400);
      expect(state.calls).toHaveLength(0);
    }
  });
  it('맞는 입력은 앞 계약을 끝내고 고른 값으로 새 계약', async () => {
    const res = await post({ orgId: ORG, planType: 'pro', monthlyFee: 280000, startDate: '2026-11-19', endDate: '2027-11-18' });
    expect(res.status).toBe(200);
    const ins = state.calls.find((c) => did(c, 'insert'))!;
    const row = ins.ops.find(([n]) => n === 'insert')![1][0] as Record<string, unknown>;
    expect(row).toMatchObject({ organization_id: ORG, plan: 'pro', price_per_month: 280000, billing_type: 'pay_as_you_go', budget_alert_percent: 80, notes: null });
    // 끝내기가 먼저
    expect(state.calls.findIndex((c) => c.table === 'contracts' && did(c, 'update'))).toBeLessThan(state.calls.indexOf(ins));
  });
});

describe('기관 상세 계약 탭 — 원본 확인', () => {
  const src = readFileSync('src/app/super/organizations/[id]/page.tsx', 'utf8');
  const tab = src.slice(src.indexOf('function ContractsTab'), src.indexOf('function InviteRow'));
  it('계약 화면과 같은 계약 만들기로 보낸다(기관 요금제 이름만 바꾸지 않음)', () => {
    expect(tab).toContain("fetch('/api/super/contracts'");
    expect(tab).not.toContain('`/api/super/organizations/${orgId}`, {');
    expect(tab).toContain('startDate: form.startDate');
    expect(tab).toContain('monthlyFee: form.fee');
  });
  it('응답을 보고, 실패면 창을 닫지 않는다', () => {
    const h = tab.slice(tab.indexOf('const handleAdd'), tab.indexOf('const PLAN_PRESETS_FEE'));
    expect(h).toContain('if (!res.ok || !d?.ok)');
    expect(h.indexOf('if (!res.ok || !d?.ok)')).toBeLessThan(h.indexOf('setShowModal(false)'));
  });
  it('요금제 기본 이용료는 요금제 표에서', () => {
    expect(tab).toContain('Object.entries(PLANS)');
    expect(tab).not.toContain('99000');
  });
});
