import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'fs';
import { join } from 'path';

/**
 * 한국 시간 날짜 셈(2026-11-06) — 서버는 UTC라 `toISOString().slice(0, 10)`·`getHours()`·`new Date(y, m, 1)`이
 * 한국 00:00~09:00의 일을 전날로, '이번 달'을 1일 09:00부터로, 시간별 표를 9시간 밀어 셌다
 */

const state = vi.hoisted(() => ({ calls: [] as unknown[][], rows: [] as unknown[] }));
vi.mock('@/lib/super-auth', () => ({ getSuperAdminFromRequest: () => ({ id: 'super' }) }));
vi.mock('@/lib/supabaseAdmin', () => ({
  supabaseAdmin: {
    from(table: string) {
      const q: Record<string, unknown> = {};
      for (const m of ['select', 'eq', 'gte', 'lte', 'lt', 'in', 'order', 'range']) q[m] = (...args: unknown[]) => { state.calls.push([table, m, ...args]); return q; };
      q.then = (resolve: (v: unknown) => unknown) => resolve({ data: table === 'usage_logs' ? state.rows : [], error: null, count: table === 'usage_logs' ? state.rows.length : 0 });
      return q;
    },
  },
}));

import { NextRequest } from 'next/server';
import { addKstDays, kstDay, kstDayList, kstDayStart, kstHour, kstMonthStart } from '@/lib/kst-time';
import { GET as superUsage } from '@/app/api/super/usage/route';

describe('한국 날짜 셈', () => {
  it('날짜·시 — 한국 00:00(UTC 15:00)을 넘으면 다음 날', () => {
    expect(kstDay('2026-11-05T14:59:59.999Z')).toBe('2026-11-05');
    expect(kstDay('2026-11-05T15:00:00Z')).toBe('2026-11-06');
    expect(kstDay('2026-11-05T23:30:00Z')).toBe('2026-11-06');
    expect(kstHour('2026-11-05T23:30:00Z')).toBe(8);
    expect(kstHour('2026-11-05T15:00:00Z')).toBe(0);
  });

  it('그날 시작·날짜 더하기·달의 시작(연·달 경계)', () => {
    expect(kstDayStart('2026-11-06').toISOString()).toBe('2026-11-05T15:00:00.000Z');
    expect(addKstDays('2026-11-30', 1)).toBe('2026-12-01');
    expect(addKstDays('2026-03-01', -1)).toBe('2026-02-28');
    const firstMorning = Date.parse('2026-10-31T16:00:00Z'); // 한국 11월 1일 01:00
    expect(kstMonthStart(firstMorning, 0).toISOString()).toBe('2026-10-31T15:00:00.000Z');
    expect(kstMonthStart(firstMorning, -1).toISOString()).toBe('2026-09-30T15:00:00.000Z');
    expect(kstMonthStart(Date.parse('2026-01-15T00:00:00Z'), -1).toISOString()).toBe('2025-11-30T15:00:00.000Z');
  });

  it('날짜 목록 — 끝 포함, 거꾸로면 빈 목록, 400일 상한', () => {
    expect(kstDayList('2026-10-30', '2026-11-02')).toEqual(['2026-10-30', '2026-10-31', '2026-11-01', '2026-11-02']);
    expect(kstDayList('2026-11-02', '2026-11-01')).toEqual([]);
    expect(kstDayList('2020-01-01', '2026-01-01')).toHaveLength(400);
  });
});

describe('슈퍼관리자 사용량 — 고른 기간·시간별 표', () => {
  beforeEach(() => { state.calls = []; state.rows = []; vi.useFakeTimers(); vi.setSystemTime(new Date('2026-11-05T23:30:00Z')); });
  afterEach(() => { vi.useRealTimers(); });

  it('끝 날은 그날 한국 23:59:59.999까지, 시작 날은 그날 한국 00:00부터', async () => {
    await superUsage(new NextRequest('http://localhost/api/super/usage?period=custom&startDate=2026-11-01&endDate=2026-11-05'));
    expect(state.calls).toContainEqual(['usage_logs', 'gte', 'created_at', '2026-10-31T15:00:00.000Z']);
    expect(state.calls).toContainEqual(['usage_logs', 'lte', 'created_at', '2026-11-05T14:59:59.999Z']);
  });

  it('오늘은 한국 날짜로 시작하고, 시간별 표는 한국 시로 센다', async () => {
    state.rows = [{ user_id: 'u', organization_id: 'o', details: { input_tokens: 1, output_tokens: 1 }, created_at: '2026-11-05T23:10:00Z' }];
    const res = await superUsage(new NextRequest('http://localhost/api/super/usage?period=today'));
    expect(state.calls).toContainEqual(['usage_logs', 'gte', 'created_at', '2026-11-05T15:00:00.000Z']);
    const body = await res.json();
    const stats = (body.data?.timeStats ?? body.timeStats ?? []) as { hour: string; conversations: number }[];
    expect(stats.find((s) => s.hour === '08:00')?.conversations).toBe(1);
  });
});

describe('UTC 날짜 셈이 다시 들어오지 않게', () => {
  const walk = (d: string): string[] => readdirSync(d).flatMap((f) => { const p = join(d, f); return statSync(p).isDirectory() ? walk(p) : /\.tsx?$/.test(f) ? [p] : []; });
  it('API 라우트에 로컬(UTC) 달·날의 시작·getHours가 없다', () => {
    const offenders = walk('src/app/api').filter((f) => /new Date\((now|new Date\(\))\.getFullYear\(\)|\.getHours\(\)/.test(readFileSync(f, 'utf8')));
    expect(offenders).toEqual([]);
  });
  it('고친 곳 — 날짜 열쇠를 UTC로 자르지 않는다', () => {
    for (const f of ['src/app/api/my/stats/route.ts', 'src/app/api/super/dashboard/route.ts', 'src/app/api/super/usage/route.ts', 'src/app/api/super/organizations/[id]/usage/route.ts', 'src/lib/connectors/dart.ts', 'src/lib/connectors/g2b.ts', 'src/components/admin/AuditLogsManager.tsx', 'src/components/admin/UsageSummary.tsx']) {
      expect(readFileSync(f, 'utf8'), f).not.toMatch(/toISOString\(\)\.slice\(0, ?10\)|created_at\.slice\(0, ?10\)/);
    }
  });
});
