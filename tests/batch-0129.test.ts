import { readFileSync } from 'fs';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const logs = vi.hoisted(() => [] as Array<{ level: string; category: string; message: string; details?: Record<string, unknown> }>);
vi.mock('@/lib/supabaseAdmin', () => ({ supabaseAdmin: {} }));
vi.mock('@/lib/logger', () => ({ logSystem: vi.fn(async (p) => { logs.push(p); }) }));

import { IP_FAILURES, IP_LOCK_STARTED, LOCK_WINDOW_MS, ipKey, lockedIpCount, noteSignInFailure, type ThrottleDeps } from '@/lib/sign-in-throttle';

/**
 * 2026-11-17 — IP 잠금이 걸린 것을 운영자가 알게. 막 잠긴 순간(30번째 실패) 가린 IP로 한 번 남기고,
 * 슈퍼관리자 대시보드가 지금 막힌 IP 수와 최근 잠긴 가린 IP를 띠로 보인다(계정 관리의 'IP 확인·풀기'로 잇는다).
 */

const NOW = Date.parse('2026-11-17T02:00:00Z');
beforeEach(() => { logs.length = 0; });

function deps(ipCount: number | null, recordFails = false) {
  const counted: Array<[string, string, string]> = [];
  const d: ThrottleDeps = {
    countFailures: async (scope, field, value, since) => { counted.push([field, value, since]); return ipCount; },
    recordFailure: async () => { if (recordFails) throw { code: '42P01' }; },
    clearFailures: async () => {},
  };
  return { d, counted };
}

describe('막 잠긴 순간 한 번', () => {
  it('30번째 실패면 warning·security에 가린 IP·범위만', async () => {
    const { d, counted } = deps(IP_FAILURES);
    await noteSignInFailure(d, 'user', 'kim@x.go.kr', '203.0.113.5', NOW);
    expect(counted).toEqual([['ip_hash', ipKey('203.0.113.5'), new Date(NOW - LOCK_WINDOW_MS).toISOString()]]);
    expect(logs).toEqual([{ level: 'warning', category: 'security', message: IP_LOCK_STARTED, details: { scope: 'user', ip: '203.0.113.x' } }]);
    expect(JSON.stringify(logs)).not.toContain('kim@');
    expect(JSON.stringify(logs)).not.toContain('203.0.113.5');
  });
  it('29번·31번·못 읽음이면 남기지 않음', async () => {
    for (const n of [IP_FAILURES - 1, IP_FAILURES + 1, null]) await noteSignInFailure(deps(n).d, 'user', 'a@b.kr', '203.0.113.5', NOW);
    expect(logs).toEqual([]);
  });
  it('IP를 모르거나 실패 기록을 못 남겼으면 세지 않음', async () => {
    const a = deps(IP_FAILURES);
    await noteSignInFailure(a.d, 'user', 'a@b.kr', null, NOW);
    expect(a.counted).toEqual([]);
    const b = deps(IP_FAILURES, true);
    await noteSignInFailure(b.d, 'super', 'a@b.kr', '203.0.113.5', NOW);
    expect(b.counted).toEqual([]);
    expect(logs.map((l) => l.message)).not.toContain(IP_LOCK_STARTED);
  });
});

describe('지금 막힌 IP 수', () => {
  it('30번 넘은 해시만 센다, 빈 값은 뺀다', () => {
    const rows = [...Array(IP_FAILURES).fill('a'), ...Array(IP_FAILURES - 1).fill('b'), ...Array(IP_FAILURES + 5).fill('c'), null, null];
    expect(lockedIpCount(rows)).toBe(2);
    expect(lockedIpCount([])).toBe(0);
  });
});

describe('대시보드(원본)', () => {
  it('API가 30분 창의 실패 IP 해시와 막 잠김 기록을 읽고, 못 읽으면 null', () => {
    const src = readFileSync('src/app/api/super/dashboard/route.ts', 'utf8');
    expect(src).toContain("supabaseAdmin.from('sign_in_failures').select('ip_hash', w ? { count: 'exact' } : undefined)");
    expect(src).toContain('pagedRows<{ ip_hash: string | null }>');
    expect(src).toContain("eq('message', IP_LOCK_STARTED)");
    expect(src).toContain('lockedIps: ipFailures.error ? null : {');
  });
  it('화면이 띠를 보이고 계정 관리로 잇는다', () => {
    const page = readFileSync('src/app/super/page.tsx', 'utf8');
    expect(page).toContain('al.lockedIps?.count > 0');
    expect(page).toContain('href="/super/accounts"');
  });
});
