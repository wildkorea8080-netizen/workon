import { readFileSync } from 'fs';
import { describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/supabaseAdmin', () => ({ supabaseAdmin: {} }));
vi.mock('@/lib/logger', () => ({ logSystem: async () => {} }));

import { IP_FAILURES, LOCK_WINDOW_MS, ipKey, ipLockStatus, lockedUntil, requestIp, unlockIp, type IpLockDeps } from '@/lib/sign-in-throttle';
import { maskIp, normalizeIp } from '@/lib/sign-in-lock-spec';

/**
 * 2026-11-17 — IP 로그인 잠금 확인·풀기(슈퍼관리자). 한 IP 30분 30번 실패면 그 IP를 막는데, 기관 전체가 바깥 IP 하나를 함께 쓰면
 * 기관 전체가 30분 못 들어온다. 예전엔 풀 길이 없었다.
 */

const NOW = Date.parse('2026-11-17T01:00:00Z');
const at = (minAgo: number) => new Date(NOW - minAgo * 60_000).toISOString();

describe('IP 다듬기·가리기', () => {
  it('IPv4·IPv6만 받고, 앞뒤 공백을 떼고 IPv6는 소문자로', () => {
    expect(normalizeIp(' 203.0.113.5 ')).toBe('203.0.113.5');
    expect(normalizeIp('2001:DB8::1')).toBe('2001:db8::1');
    for (const bad of ['', '203.0.113', '203.0.113.256', '203.0.113.05', 'abc', '1.2.3.4; drop', null, 5, 'x'.repeat(60) + ':']) expect(normalizeIp(bad)).toBeNull();
  });
  it('기록·화면에는 가린 IP만', () => {
    expect(maskIp('203.0.113.5')).toBe('203.0.113.x');
    expect(maskIp('2001:db8:85a3::8a2e:370:7334')).toBe('2001:db8:85a3:…');
  });
  it('다듬은 IP의 해시가 로그인 때 머리글에서 남긴 해시와 같다', () => {
    expect(ipKey(normalizeIp(' 203.0.113.5 '))).toBe(ipKey(requestIp({ 'x-forwarded-for': '203.0.113.5, 10.0.0.1' })));
  });
});

describe('IP 잠금 상태', () => {
  const deps = (times: string[]) => {
    const cleared: string[] = [];
    const d: IpLockDeps = {
      ipFailures: vi.fn(async (hash, since) => { expect(hash).toBe(ipKey('203.0.113.5')); expect(since).toBe(new Date(NOW - LOCK_WINDOW_MS).toISOString()); return times; }),
      clearIp: vi.fn(async (hash) => { cleared.push(hash); return times.length; }),
    };
    return { d, cleared };
  };
  it('29번이면 잠기지 않음, 30번이면 잠김 — 풀리는 때는 창 안 실패가 30번 아래로 떨어질 때', async () => {
    expect(IP_FAILURES).toBe(30);
    const t29 = Array.from({ length: 29 }, (_, i) => at(29 - i));
    expect(await ipLockStatus(deps(t29).d, '203.0.113.5', NOW)).toEqual({ failures: 29, lockedUntil: null });
    const t30 = Array.from({ length: 30 }, (_, i) => at(29 - i));
    const s = await ipLockStatus(deps(t30).d, '203.0.113.5', NOW);
    expect(s.failures).toBe(30);
    expect(s.lockedUntil).toBe(new Date(Date.parse(at(29)) + LOCK_WINDOW_MS).toISOString());
    expect(lockedUntil(t30, NOW, IP_FAILURES)).toBe(s.lockedUntil);
  });
  it('풀기는 그 IP 해시의 기록을 지우고 지운 수를 돌려준다', async () => {
    const { d, cleared } = deps([at(1), at(2)]);
    expect(await unlockIp(d, '203.0.113.5')).toBe(2);
    expect(cleared).toEqual([ipKey('203.0.113.5')]);
  });
  it('계정 잠금 판정(5번)은 그대로', () => {
    const t5 = Array.from({ length: 5 }, (_, i) => at(5 - i));
    expect(lockedUntil(t5, NOW)).not.toBeNull();
    expect(lockedUntil(t5.slice(1), NOW)).toBeNull();
  });
});

describe('라우트·화면(원본)', () => {
  const route = readFileSync('src/app/api/super/sign-in-ip-lock/route.ts', 'utf8');
  it('두 핸들러 모두 첫 줄에서 슈퍼관리자 확인, 꼴이 아닌 IP는 400', () => {
    for (const h of ['GET', 'DELETE']) {
      const body = route.slice(route.indexOf(`export async function ${h}`));
      expect(body.slice(0, 200)).toContain('getSuperAdminFromRequest(request)');
    }
    expect(route.match(/BAD_IP \} \}, \{ status: 400 \}/g)?.length).toBe(2);
  });
  it('기록(super_admin_logs)에는 가린 IP·지운 수만, 원래 IP는 응답·기록에 안 싣는다', () => {
    expect(route).toContain("action: 'sign_in_ip_unlocked'");
    expect(route).toContain('after_data: { ip: maskIp(ip), cleared }');
    expect(route).not.toMatch(/data: \{ ip(,| \})/);
  });
  it('슈퍼관리자 계정 관리 화면에 IP 잠금 확인·풀기', () => {
    const page = readFileSync('src/app/super/accounts/page.tsx', 'utf8');
    expect(page).toContain('<IpLockPanel onToast={showToast} />');
    expect(page).toContain("requestJson('/api/super/sign-in-ip-lock', { method: 'DELETE'"); // 0264부터 던지지 않는 requestJson
    expect(page).toContain('isImeComposing(e)) check()');
  });
});
