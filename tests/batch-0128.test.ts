import { readFileSync } from 'fs';
import { describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/supabaseAdmin', () => ({ supabaseAdmin: {} }));
vi.mock('@/lib/logger', () => ({ logSystem: async () => {} }));

import { IP_FAILURES, LOCK_FAILURES, signInAllowed, signInLock, type ThrottleDeps } from '@/lib/sign-in-throttle';
import { IP_LOCKED, IP_LOCKED_MESSAGE, LOCKED_MESSAGE } from '@/lib/sign-in-lock-spec';

/**
 * 2026-11-17 — IP 잠금은 계정 잠금과 안내가 다르다. 한 IP 30번 잠금은 기관 관리자도 같은 주소라 들어와 풀 수 없고
 * 계정 잠금 풀기로도 안 풀린다 — 서비스 운영자(슈퍼관리자 'IP 로그인 잠금')만 푼다. 예전엔 같은 '계정 잠김' 안내라 엉뚱한 사람에게 물었다.
 */

const deps = (o: { key?: number | null; ip?: number | null }): ThrottleDeps => ({
  countFailures: async (_s, field) => (field === 'key_hash' ? o.key ?? 0 : o.ip ?? 0),
  recordFailure: async () => {},
  clearFailures: async () => {},
});

describe('무엇이 잠겼는가', () => {
  it('계정 5번 → account, IP 30번 → ip, 둘 다면 ip(계정을 풀어도 못 들어오므로)', async () => {
    expect(await signInLock(deps({ key: LOCK_FAILURES }), 'user', 'a@b.kr', '1.2.3.4')).toBe('account');
    expect(await signInLock(deps({ ip: IP_FAILURES }), 'user', 'a@b.kr', '1.2.3.4')).toBe('ip');
    expect(await signInLock(deps({ key: LOCK_FAILURES, ip: IP_FAILURES }), 'user', 'a@b.kr', '1.2.3.4')).toBe('ip');
    expect(await signInLock(deps({ key: LOCK_FAILURES - 1, ip: IP_FAILURES - 1 }), 'user', 'a@b.kr', '1.2.3.4')).toBeNull();
  });
  it('못 읽으면 열림, IP를 모르면 IP는 안 봄 — signInAllowed와 같은 판정', async () => {
    expect(await signInLock(deps({ key: null, ip: null }), 'user', 'a@b.kr', '1.2.3.4')).toBeNull();
    expect(await signInLock(deps({ ip: IP_FAILURES }), 'user', 'a@b.kr', null)).toBeNull();
    for (const o of [{ key: LOCK_FAILURES }, { ip: IP_FAILURES }, {}]) {
      expect(await signInAllowed(deps(o), 'super', 'a@b.kr', '1.2.3.4')).toBe((await signInLock(deps(o), 'super', 'a@b.kr', '1.2.3.4')) === null);
    }
  });
});

describe('안내', () => {
  it('IP 잠금 안내는 계정을 말하지 않고 서비스 운영자를 가리킨다', () => {
    expect(IP_LOCKED).toBe('IP_LOCKED');
    expect(IP_LOCKED_MESSAGE).toContain('인터넷 주소');
    expect(IP_LOCKED_MESSAGE).toContain('서비스 운영자');
    expect(IP_LOCKED_MESSAGE).not.toContain('계정');
    expect(IP_LOCKED_MESSAGE).not.toBe(LOCKED_MESSAGE);
  });
  it('직원 로그인·슈퍼관리자 로그인·로그인 화면이 둘을 가른다', () => {
    const auth = readFileSync('src/lib/nextAuthOptions.ts', 'utf8');
    expect(auth).toContain("throw new Error(lock === 'ip' ? IP_LOCKED : ACCOUNT_LOCKED);");
    expect(auth).not.toContain('signInAllowed(');
    const sup = readFileSync('src/app/api/super/auth/login/route.ts', 'utf8');
    expect(sup).toContain("error: lock === 'ip' ? IP_LOCKED_MESSAGE : LOCKED_MESSAGE");
    expect(sup).toContain('details: { lock }');
    const form = readFileSync('src/components/auth/LoginForm.tsx', 'utf8');
    expect(form).toContain('res.error === IP_LOCKED ? IP_LOCKED_MESSAGE');
  });
});
