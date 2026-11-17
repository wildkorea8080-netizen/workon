import { readFileSync } from 'fs';
import { describe, expect, it } from 'vitest';
import { contractEndMs, contractInForce, kstMonthRange, kstYearMonth, revenueIn, type RevenueContract } from '@/lib/contract-revenue';

/**
 * 2026-11-17 — 계약 매출을 한 규칙으로. 슈퍼관리자 대시보드 '이번달 매출'은 이번 달에 '시작한' 계약만 더해 운영(4월부터 월 1,090,000원)에서
 * 0원이었고, 계약 '매출 현황'은 그해 시작한 계약만·UTC 달 경계·해지 뒤에도 매달 더함(새 계약과 겹침)이었다.
 */

const NOV = kstMonthRange(2026, 11);
const OCT = kstMonthRange(2026, 10);
const c = (o: Partial<RevenueContract>): RevenueContract => ({ status: 'active', price_per_month: '100000.00', started_at: '2026-04-25T00:00:00Z', expires_at: null, updated_at: '2026-04-25T13:06:00Z', ...o });

describe('한국 시간 달', () => {
  it('11월 = 10/31 15:00Z ~ 11/30 15:00Z', () => {
    expect(new Date(NOV[0]).toISOString()).toBe('2026-10-31T15:00:00.000Z');
    expect(new Date(NOV[1]).toISOString()).toBe('2026-11-30T15:00:00.000Z');
    expect(new Date(kstMonthRange(2026, 12)[1]).toISOString()).toBe('2026-12-31T15:00:00.000Z');
  });
  it('지금의 한국 연·월 — UTC 12월 31일 16시는 한국 1월', () => {
    expect(kstYearMonth(Date.parse('2026-12-31T16:00:00Z'))).toEqual({ year: 2027, month: 1 });
    expect(kstYearMonth(Date.parse('2026-11-17T14:00:00Z'))).toEqual({ year: 2026, month: 11 });
  });
});

describe('유효 기간', () => {
  it('4월에 시작해 끝날 날 없는 계약은 11월에도 유효(예전 대시보드는 0원)', () => {
    const rows = [c({}), c({ price_per_month: '990000.00', started_at: '2026-04-27T00:00:00Z' })];
    expect(revenueIn(rows, ...NOV)).toEqual({ revenue: 1_090_000, count: 2 });
    expect(revenueIn(rows, ...OCT).revenue).toBe(1_090_000);
  });
  it('앞으로 시작할 계약·끝난 계약은 빠짐', () => {
    expect(contractInForce(c({ started_at: '2026-12-01T00:00:00Z' }), ...NOV)).toBe(false);
    expect(contractInForce(c({ expires_at: '2026-10-15T00:00:00Z' }), ...NOV)).toBe(false);
    expect(contractInForce(c({ expires_at: '2026-11-02T00:00:00Z' }), ...NOV)).toBe(true); // 하루라도
  });
  it('해지된 계약은 해지한 때까지만 — 새 계약과 겹쳐 세지 않음', () => {
    const old = c({ status: 'cancelled', updated_at: '2026-09-10T00:00:00Z' });
    const neu = c({ started_at: '2026-09-10T00:00:00Z', price_per_month: 200000 });
    expect(revenueIn([old, neu], ...kstMonthRange(2026, 9)).revenue).toBe(300_000); // 9월엔 둘 다 하루라도 유효
    expect(revenueIn([old, neu], ...OCT).revenue).toBe(200_000); // 예전 셈은 300,000
    expect(contractEndMs(c({ status: 'cancelled', updated_at: null }))).toBe(-Infinity); // 해지 때를 모르면 세지 않음
  });
  it('다른 상태·이상한 값은 0', () => {
    expect(revenueIn([c({ status: 'expired' }), c({ price_per_month: 'abc' }), c({ price_per_month: -5 }), c({ started_at: null })], ...NOV)).toEqual({ revenue: 0, count: 2 });
  });
  it('잎 파일', () => {
    expect(readFileSync('src/lib/contract-revenue.ts', 'utf8')).not.toMatch(/^import /m);
  });
});

describe('쓰는 곳', () => {
  it("대시보드 '이번달 매출'은 그달에 유효했던 계약", () => {
    const s = readFileSync('src/app/api/super/dashboard/route.ts', 'utf8');
    expect(s).toContain("revenueIn(revenueRows, Date.parse(monthStart), Date.parse(nextMonthStart))");
    expect(s).not.toMatch(/contracts'\)\.select\('price_per_month'\)\.eq\('status', 'active'\)\.gte\('started_at'/);
  });
  it('매출 현황 — 한국 시간 달, 그해 전 시작한 계약도, 앞날은 세지 않음', () => {
    const s = readFileSync('src/app/api/super/contracts/revenue/route.ts', 'utf8');
    expect(s).toContain('kstMonthRange(year, m)');
    expect(s).not.toContain(".gte('started_at', `${year}-01-01`)");
    expect(s).toContain('future ? { revenue: 0, count: 0 }');
  });
});
