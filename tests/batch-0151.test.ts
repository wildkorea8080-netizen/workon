import { readFileSync } from 'fs';
import { describe, expect, it } from 'vitest';
import { contractsSummary, type RevenueContract } from '@/lib/contract-revenue';

/**
 * 2026-11-18 — 슈퍼관리자 계약 화면의 요약 카드. 예전엔 상태가 활성인 계약을 모두 세고 월 이용료를 모두 더해
 * 끝날 날이 지난 계약·아직 시작하지 않은 계약까지 '활성 계약'·'월 매출'에 들어갔고, 이번 달에 해지한 계약은 빠져
 * 대시보드 '이번달 매출'(그달에 유효했던 계약 — batch-0144)과 숫자가 달랐다. 요약을 못 읽어도 0으로 보였다.
 */

const NOW = Date.parse('2026-11-18T03:00:00Z'); // 한국 11월 18일 12시
const c = (o: Partial<RevenueContract>): RevenueContract => ({
  status: 'active', price_per_month: '100000.00', started_at: '2026-04-25T00:00:00Z', expires_at: null, updated_at: '2026-04-25T13:06:00Z', ...o,
});

describe('contractsSummary', () => {
  it('끝날 날 없는 활성 계약 — 활성 1·이번 달 매출', () => {
    expect(contractsSummary([c({})], NOW)).toEqual({ totalActive: 1, expiringIn30Days: 0, totalMonthlyRevenue: 100_000 });
  });
  it('끝날 날이 지난 활성 계약은 활성이 아니고, 이번 달 전에 끝났으면 매출도 아님', () => {
    const s = contractsSummary([c({ expires_at: '2026-10-01T00:00:00Z' })], NOW);
    expect(s).toEqual({ totalActive: 0, expiringIn30Days: 0, totalMonthlyRevenue: 0 });
  });
  it('이번 달 중에 끝난 계약 — 활성은 아니지만 이번 달 매출에는 든다(대시보드와 같음)', () => {
    const s = contractsSummary([c({ expires_at: '2026-11-10T00:00:00Z' })], NOW);
    expect(s.totalActive).toBe(0);
    expect(s.totalMonthlyRevenue).toBe(100_000);
  });
  it('30일 안에 끝나는 계약은 만료 임박', () => {
    const s = contractsSummary([c({ expires_at: '2026-12-10T00:00:00Z' }), c({ expires_at: '2027-03-01T00:00:00Z' })], NOW);
    expect(s.totalActive).toBe(2);
    expect(s.expiringIn30Days).toBe(1);
  });
  it('다음 달에 시작하는 계약은 활성으로 세되 이번 달 매출은 아님', () => {
    const s = contractsSummary([c({ started_at: '2026-12-05T00:00:00Z' })], NOW);
    expect(s.totalActive).toBe(1);
    expect(s.totalMonthlyRevenue).toBe(0);
  });
  it('이번 달에 해지한 계약은 이번 달 매출에 들고, 해지 뒤 새 계약과 겹쳐도 각각 그달 한 번', () => {
    const rows = [
      c({ status: 'cancelled', updated_at: '2026-11-05T00:00:00Z' }),
      c({ price_per_month: 200000, started_at: '2026-11-05T00:00:00Z' }),
    ];
    expect(contractsSummary(rows, NOW)).toEqual({ totalActive: 1, expiringIn30Days: 0, totalMonthlyRevenue: 300_000 });
  });
  it('지난달에 해지한 계약은 아무 데도 안 셈', () => {
    expect(contractsSummary([c({ status: 'cancelled', updated_at: '2026-10-05T00:00:00Z' })], NOW))
      .toEqual({ totalActive: 0, expiringIn30Days: 0, totalMonthlyRevenue: 0 });
  });
});

describe('계약 목록 라우트', () => {
  const s = readFileSync('src/app/api/super/contracts/route.ts', 'utf8');
  it('요약은 contractsSummary로, 쪽마다 끝까지 읽음', () => {
    expect(s).toContain('contractsSummary(all.data, now)');
    expect(s).toContain("pagedRows<RevenueContract>(");
    expect(s).toContain(".in('status', ['active', 'cancelled'])");
    expect(s).not.toContain('allActive');
  });
  it('못 읽으면 503 — 0으로 꾸미지 않음', () => {
    expect(s).toMatch(/if \(all\.error\) \{\s*return NextResponse\.json\([^\n]*\{ status: 503 \}/);
  });
  it('화면 카드는 이번 달 매출', () => {
    expect(readFileSync('src/app/super/contracts/page.tsx', 'utf8')).toContain("label: '이번 달 매출'");
  });
});
