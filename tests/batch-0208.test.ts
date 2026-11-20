import { readFileSync } from 'fs';
import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * 2026-11-20 — 슈퍼관리자 로그 관리·계정 관리의 요약 수가 읽기 실패를 0으로 보이지 않는다.
 * ① 시스템 로그 '오늘·이번주 ERROR/CRITICAL'을 못 세면 0건이라 '오류 없음'으로 읽혔다.
 * ② 계정 관리 '이번달 신규'를 못 세면 0명이었고, 부서 없는 기관을 고르면 칸이 아예 빠졌다.
 */

const state = { failCounts: false };

vi.mock('@/lib/super-auth', () => ({ getSuperAdminFromRequest: async () => ({ id: 's1' }) }));
vi.mock('@/lib/sign-in-throttle', async (orig) => ({
  ...(await orig<typeof import('@/lib/sign-in-throttle')>()),
  accountLocks: async () => new Map(),
}));
vi.mock('@/lib/paged-select', () => ({
  pagedRows: async () => ({ data: [], error: null, truncated: false, total: 0 }),
}));
vi.mock('@/lib/supabaseAdmin', () => ({
  supabaseAdmin: {
    from: () => {
      let head = false;
      const b: Record<string, unknown> = {};
      b.select = (_c: string, o?: { head?: boolean }) => { head = !!o?.head; return b; };
      for (const n of ['eq', 'in', 'is', 'not', 'lt', 'lte', 'gte', 'order', 'or', 'limit', 'range']) b[n] = () => b;
      b.then = (ok: (v: unknown) => unknown, bad: (e: unknown) => unknown) => Promise.resolve(
        head && state.failCounts
          ? { data: null, error: { code: 'XX000' }, count: null }
          : { data: [], error: null, count: head ? 4 : 0 },
      ).then(ok, bad);
      return b;
    },
  },
}));

import { GET as systemLogs } from '@/app/api/super/logs/system/route';
import { GET as accountUsers } from '@/app/api/super/accounts/users/route';

beforeEach(() => { state.failCounts = false; });

describe('GET /api/super/logs/system 요약', () => {
  const get = async () => (await (await systemLogs(new Request('http://x/api/super/logs/system') as never)).json());
  it('못 세면 null', async () => {
    state.failCounts = true;
    expect((await get()).summary).toEqual({ todayErrors: null, weekErrors: null, weekTrend: null });
  });
  it('세면 수 그대로', async () => {
    expect((await get()).summary).toEqual({ todayErrors: 4, weekErrors: 4, weekTrend: 0 });
  });
});

describe('GET /api/super/accounts/users 이번달 신규', () => {
  const get = async (q = '') => (await (await accountUsers(new Request(`http://x/api/super/accounts/users${q}`) as never)).json());
  it('못 세면 null', async () => {
    state.failCounts = true;
    expect((await get()).meta.newThisMonth).toBeNull();
  });
  it('세면 수 그대로, 부서 없는 기관을 골라도 칸이 있다', async () => {
    expect((await get()).meta.newThisMonth).toBe(4);
    expect((await get('?orgId=00000000-0000-0000-0000-000000000001')).meta.newThisMonth).toBe(4);
  });
});

describe('화면', () => {
  it('못 읽은 수는 "읽지 못함"', () => {
    const logs = readFileSync('src/app/super/logs/page.tsx', 'utf8');
    expect(logs).toContain("summary.todayErrors === null ? '읽지 못함'");
    expect(logs).toContain("summary.weekErrors === null ? '읽지 못함'");
    expect(logs).not.toContain('summary.todayErrors ?? 0');
    const acc = readFileSync('src/app/super/accounts/page.tsx', 'utf8');
    expect(acc).toContain("meta.newThisMonth === null ? '읽지 못함' : meta.newThisMonth");
  });
});
