import { readFileSync } from 'fs';
import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * 2026-11-19 — 기한이 지난 계약을 보이게.
 * 계약을 '만료'로 바꾸는 일이 어디에도 없어 끝날 날이 지나도 `status`는 'active'로 남는다. 예전 '만료 예정' 탭·대시보드
 * '계약 만료 임박'은 앞으로 30일 안만 세어 **이미 기한이 지난 계약은 어떤 알림에도 없었고**, 계약 목록에는 '활성'으로 보였다.
 * 대시보드의 '계약 확인'(?tab=expiring)으로 들어가도 늘 '계약 현황' 탭이었다.
 */

const state = { rows: [] as Array<Record<string, unknown>>, ops: [] as Array<[string, unknown[]]>, error: null as unknown };

vi.mock('@/lib/super-auth', () => ({ getSuperAdminFromRequest: () => ({ sub: 'sa' }) }));
vi.mock('@/lib/supabaseAdmin', () => ({
  supabaseAdmin: {
    from: () => {
      const b: Record<string, unknown> = {};
      for (const n of ['select', 'eq', 'not', 'lte', 'gte', 'lt', 'order']) b[n] = (...a: unknown[]) => { state.ops.push([n, a]); return b; };
      b.then = (res: (v: unknown) => unknown) => Promise.resolve({ data: state.error ? null : state.rows, error: state.error }).then(res);
      return b;
    },
  },
}));

import { contractDaysLeft, contractStatusLabel, expiryText, isContractOverdue } from '@/lib/contract-expiry';
import { GET } from '@/app/api/super/contracts/expiring/route';

const NOW = Date.parse('2026-11-19T12:00:00Z');
const DAY = 86_400_000;

beforeEach(() => { state.rows = []; state.ops = []; state.error = null; });

describe('contract-expiry', () => {
  it('남은 날·기한 지남', () => {
    expect(contractDaysLeft(null, NOW)).toBeNull();
    expect(contractDaysLeft('not-a-date', NOW)).toBeNull();
    expect(contractDaysLeft(new Date(NOW + 10 * DAY).toISOString(), NOW)).toBe(10);
    expect(contractDaysLeft(new Date(NOW - 3 * DAY).toISOString(), NOW)).toBe(-3);
    expect(isContractOverdue('active', new Date(NOW - 1).toISOString(), NOW)).toBe(true);
    expect(isContractOverdue('active', new Date(NOW + DAY).toISOString(), NOW)).toBe(false);
    expect(isContractOverdue('cancelled', new Date(NOW - DAY).toISOString(), NOW)).toBe(false);
    expect(isContractOverdue('active', null, NOW)).toBe(false);
  });
  it('상태 이름 — 지난 활성 계약은 기한 지남', () => {
    expect(contractStatusLabel('active', new Date(NOW - DAY).toISOString(), NOW)).toBe('기한 지남');
    expect(contractStatusLabel('active', new Date(NOW + DAY).toISOString(), NOW)).toBe('활성');
    expect(contractStatusLabel('active', null, NOW)).toBe('활성');
    expect(contractStatusLabel('cancelled', null, NOW)).toBe('해지');
    expect(contractStatusLabel('expired', null, NOW)).toBe('만료');
  });
  it('남은 날 글', () => {
    expect(expiryText(5, false)).toBe('D-5일 남음');
    expect(expiryText(-3, true)).toBe('기한 3일 지남');
    expect(expiryText(0, true)).toBe('오늘 기한 지남');
    expect(expiryText(null, false)).toBe('무기한');
  });
});

describe('GET /api/super/contracts/expiring', () => {
  it('앞으로 30일 안 + 이미 기한이 지난 활성 계약(하한 없음)', async () => {
    state.rows = [
      { id: 'c1', organization_id: 'o1', plan: 'basic', price_per_month: 100, status: 'active', expires_at: new Date(Date.now() - 5 * DAY).toISOString(), organizations: { name: '가' } },
      { id: 'c2', organization_id: 'o2', plan: 'pro', price_per_month: 200, status: 'active', expires_at: new Date(Date.now() + 5 * DAY).toISOString(), organizations: { name: '나' } },
    ];
    const body = await (await GET(new Request('http://x/') as never)).json();
    expect(body.data.map((r: { id: string; overdue: boolean }) => [r.id, r.overdue])).toEqual([['c1', true], ['c2', false]]);
    expect(state.ops.some(([op, a]) => op === 'gte' && a[0] === 'expires_at')).toBe(false);
    expect(state.ops).toContainEqual(['eq', ['status', 'active']]);
  });
});

describe('원본 확인', () => {
  it('대시보드 — 기한 지난 계약 수를 따로 세고 띠에 보임', () => {
    const r = readFileSync('src/app/api/super/dashboard/route.ts', 'utf8');
    expect(r).toContain(".eq('status', 'active').not('expires_at', 'is', null).lt('expires_at', now.toISOString())");
    expect(r).toContain('overdueContracts: orgOverdue.error ? null : orgOverdue.count ?? 0');
    expect(readFileSync('src/app/super/page.tsx', 'utf8')).toContain('기한 지난 계약 {al.overdueContracts}개(아직 활성)');
  });
  it('계약 화면 — 상태 이름·?tab=expiring·만료 예정 읽기 실패', () => {
    const s = readFileSync('src/app/super/contracts/page.tsx', 'utf8');
    expect(s).toContain('contractStatusLabel(c.status, c.endDate, Date.now())');
    expect(s).toContain("new URLSearchParams(window.location.search).get('tab')");
    expect(s).toContain("'만료 예정 계약을 불러오지 못했습니다.'");
    expect(s).toContain('expiryText(item.daysLeft, item.overdue === true)');
  });
});
