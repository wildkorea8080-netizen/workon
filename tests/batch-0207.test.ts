import { readFileSync } from 'fs';
import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * 2026-11-20 — 슈퍼관리자 대시보드의 나머지 숫자가 읽기 실패를 0으로 보이지 않는다.
 * 예전엔 기관·사용자 수, 계약 만료 임박(0이면 알림 띠가 사라짐), 오늘·이번 달 대화·토큰·원가, 매출, 일별 차트,
 * 최근 가입 기관·시스템 로그를 못 읽으면 0개·0명·0원·빈 목록으로 보였다. 화면은 '읽지 못함'으로 보이고,
 * 대시보드 자체를 못 불러오면 그렇다고 알린다(예전엔 모든 카드가 0, 연결이 끊기면 도는 표시가 멈추지 않았다).
 */

const state = { fail: false };

function result() {
  return state.fail
    ? { data: null, error: { code: 'XX000', message: 'down' }, count: null }
    : { data: [], error: null, count: 3 };
}

vi.mock('@/lib/super-auth', () => ({ getSuperAdminFromRequest: async () => ({ id: 's1' }) }));
vi.mock('@/lib/supabaseAdmin', () => ({
  supabaseAdmin: {
    from: () => {
      const b: Record<string, unknown> = {};
      for (const n of ['select', 'eq', 'in', 'is', 'not', 'lt', 'lte', 'gte', 'order', 'limit', 'range']) b[n] = () => b;
      b.then = (ok: (v: unknown) => unknown, bad: (e: unknown) => unknown) => Promise.resolve(result()).then(ok, bad);
      return b;
    },
  },
}));
vi.mock('@/lib/paged-select', () => ({
  pagedRows: async () => (state.fail
    ? { data: [], error: { message: 'down' }, truncated: false, total: null }
    : { data: [], error: null, truncated: false, total: 0 }),
}));
vi.mock('@/lib/org-chat-tokens', async (orig) => ({
  ...(await orig<typeof import('@/lib/org-chat-tokens')>()),
  loadChatTokensByOrg: async () => (state.fail ? null : new Map<string, number>()),
}));

import { GET } from '@/app/api/super/dashboard/route';

beforeEach(() => { state.fail = false; });

const get = async () => (await (await GET(new Request('http://x') as never)).json()).data;

describe('GET /api/super/dashboard', () => {
  it('모두 못 읽으면 숫자 대신 null', async () => {
    state.fail = true;
    const d = await get();
    expect(d.organizations).toEqual({ total: null, active: null, suspended: null, expiringIn30Days: null });
    expect(d.users).toEqual({ total: null, newThisMonth: null, activeToday: null });
    expect(d.usage).toEqual({ todayConversations: null, monthConversations: null, monthTokens: null, estimatedCostUsd: null });
    expect(d.revenue).toEqual({ thisMonth: null, lastMonth: null, growthPercent: null });
    expect(d.alerts.expiringContracts).toBeNull();
    expect(d.dailyChart).toBeNull();
    expect(d.recentOrgs).toBeNull();
    expect(d.recentSystemLogs).toBeNull();
  });
  it('읽으면 수 그대로(빈 것은 0·빈 목록)', async () => {
    const d = await get();
    expect(d.organizations).toEqual({ total: 3, active: 3, suspended: 3, expiringIn30Days: 3 });
    expect(d.users).toEqual({ total: 3, newThisMonth: 3, activeToday: 0 });
    expect(d.usage).toEqual({ todayConversations: 0, monthConversations: 0, monthTokens: 0, estimatedCostUsd: 0 });
    expect(d.revenue).toEqual({ thisMonth: 0, lastMonth: 0, growthPercent: null });
    expect(d.alerts.expiringContracts).toBe(3);
    expect(d.dailyChart).toHaveLength(30);
    expect(d.recentOrgs).toEqual([]);
  });
});

describe('화면', () => {
  const page = readFileSync('src/app/super/page.tsx', 'utf8');
  it('못 읽은 숫자는 0이 아니라 "읽지 못함"', () => {
    expect(page).toContain("const shown = (v: number | null | undefined, f: (n: number) => string) => (v == null ? UNREAD : f(v));");
    expect(page).not.toMatch(/\$\{o\.total \?\? 0\}|\$\{u\.total \?\? 0\}|r\.thisMonth \?\? 0/);
    expect(page).toContain('data && al.expiringContracts === null');
    expect(page).toContain('data && data.dailyChart === null');
    expect(page).toContain('data && data.recentOrgs === null');
    expect(page).toContain('data && data.recentSystemLogs === null');
  });
  it('대시보드를 못 불러오면 알리고 도는 표시를 멈춘다', () => {
    expect(page).toContain("setLoadError('대시보드를 지금 불러오지 못했습니다.');");
    expect(page).toMatch(/finally \{\s*setLoading\(false\);/);
  });
});
