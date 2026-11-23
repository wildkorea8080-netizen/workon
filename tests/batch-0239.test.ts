import { readFileSync } from 'fs';
import { describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/supabaseAdmin', () => ({ supabaseAdmin: {} }));
vi.mock('@/lib/supabase', () => ({ supabase: {} }));

import { AUTH_UNAVAILABLE, AUTH_UNAVAILABLE_MESSAGE, isAuthUnavailable } from '@/lib/auth-unavailable';
import { changeOwnPassword, type PasswordChangeDeps } from '@/lib/password-change';
import type { ThrottleDeps } from '@/lib/sign-in-throttle';

/**
 * 2026-11-20 — 인증 서비스(Supabase Auth)가 잠깐 응답하지 않은 것을 '틀린 비밀번호'로 세지 않는다.
 * 로그인·비밀번호 바꾸기는 Auth 확인이 실패하면 무엇이든 틀린 비밀번호로 보아 로그인 실패로 셌다. Auth가 응답하지 않는 동안
 * 로그인을 시도하면 30분 5번에 계정이 잠기고, 기관이 바깥 주소 하나를 함께 쓰면 30번에 **기관 전체의 로그인이 30분 막혔다**
 * (IP 잠금 — 기관 관리자도 같은 주소라 풀 수 없다). 화면은 '이메일 또는 비밀번호가 올바르지 않습니다'였다.
 * 이제 Auth가 4xx로 답한 것(틀린 비밀번호)만 실패로 세고, 연결 실패·5xx·429·408은 세지 않고 '지금 확인하지 못했습니다'로 답한다.
 */

describe('isAuthUnavailable', () => {
  it('틀린 비밀번호(4xx)는 확인한 것이다', () => {
    expect(isAuthUnavailable({ status: 400, code: 'invalid_credentials', message: 'Invalid login credentials' })).toBe(false);
    expect(isAuthUnavailable({ status: 400, code: 'email_not_confirmed' })).toBe(false);
    expect(isAuthUnavailable({ status: 422 })).toBe(false);
  });
  it('연결 실패·5xx·요청 몰림·시간 초과는 확인하지 못한 것이다', () => {
    expect(isAuthUnavailable({ name: 'AuthRetryableFetchError', status: 0, message: 'fetch failed' })).toBe(true);
    expect(isAuthUnavailable({ message: 'fetch failed' })).toBe(true);
    expect(isAuthUnavailable({ status: 500 })).toBe(true);
    expect(isAuthUnavailable({ status: 503 })).toBe(true);
    expect(isAuthUnavailable({ status: 429 })).toBe(true);
    expect(isAuthUnavailable({ status: 408 })).toBe(true);
  });
  it('오류가 없으면 아니다', () => {
    expect(isAuthUnavailable(null)).toBe(false);
    expect(isAuthUnavailable(undefined)).toBe(false);
  });
});

const ID = '11111111-2222-3333-4444-555555555555';
function deps(verify: PasswordChangeDeps['verifyAuth'], passwordHash: string | null = null, hashOk = false) {
  const failures: string[] = [];
  const throttle: ThrottleDeps = {
    countFailures: vi.fn(async () => 0),
    recordFailure: vi.fn(async (_s: string, key: string) => { failures.push(key); }),
    clearFailures: vi.fn(async () => {}),
  };
  const d: PasswordChangeDeps = {
    throttle,
    readUser: vi.fn(async () => ({ email: 'a@x.go.kr', password_hash: passwordHash, is_active: true, deleted_at: null })),
    verifyAuth: vi.fn(verify),
    compareHash: vi.fn(async () => hashOk),
    updateAuthPassword: vi.fn(async () => 'ok' as const),
    hash: vi.fn(async (pw: string) => `h(${pw})`),
    setPasswordHash: vi.fn(async () => true),
    markPasswordChanged: vi.fn(async () => true),
  };
  return { d, failures };
}
const run = (d: PasswordChangeDeps) => changeOwnPassword(d, { userId: ID, current: 'Old-pass1', next: 'New-pass12', ip: '1.2.3.4' });

describe('비밀번호 바꾸기', () => {
  it('Auth가 확인하지 못하면 실패로 세지 않고 오류(503 갈래)로 답한다', async () => {
    const { d, failures } = deps(async () => 'unavailable');
    expect(await run(d)).toEqual({ ok: false, code: 'error' });
    expect(failures).toEqual([]);
    expect(d.updateAuthPassword).not.toHaveBeenCalled();
  });
  it('확인 중에 던져도 같다', async () => {
    const { d, failures } = deps(async () => { throw new TypeError('fetch failed'); });
    expect(await run(d)).toEqual({ ok: false, code: 'error' });
    expect(failures).toEqual([]);
  });
  it('Auth가 확인하지 못해도 저장해 둔 해시로 맞으면 바꾼다', async () => {
    const { d, failures } = deps(async () => 'unavailable', '$2a$hash', true);
    expect(await run(d)).toMatchObject({ ok: true });
    expect(failures).toEqual([]);
  });
  it('틀린 비밀번호는 예전처럼 실패로 센다', async () => {
    const { d, failures } = deps(async () => null);
    expect(await run(d)).toMatchObject({ ok: false, code: 'wrong' });
    expect(failures).toHaveLength(1);
  });
});

describe('로그인 (원본)', () => {
  const login = readFileSync('src/lib/nextAuthOptions.ts', 'utf8').replace(/\r\n/g, '\n');
  const form = readFileSync('src/components/auth/LoginForm.tsx', 'utf8').replace(/\r\n/g, '\n');

  it('Auth가 확인하지 못했고 해시로도 안 되면 실패로 세지 않고 AUTH_UNAVAILABLE을 던진다', () => {
    const branch = login.indexOf('} else if (authError && isAuthUnavailable(authError)) {');
    const counted = login.indexOf("await noteSignInFailure(throttle, 'user', credentials.email, ip);");
    expect(branch).toBeGreaterThan(-1);
    // 실패로 세는 길보다 앞에서 갈라진다
    expect(branch).toBeLessThan(counted);
    const block = login.slice(branch, counted);
    expect(block).toContain('throw new Error(AUTH_UNAVAILABLE);');
    expect(block).not.toContain('noteSignInFailure');
    expect(block).not.toContain("record('login_failed')");
  });

  it('해시로 맞는 계정은 Auth가 응답하지 않아도 그대로 들어온다(해시 확인이 먼저)', () => {
    const fallback = login.indexOf('const local = await authorizeWithPasswordHash(credentials.email, credentials.password);');
    expect(fallback).toBeGreaterThan(-1);
    expect(fallback).toBeLessThan(login.indexOf('} else if (authError && isAuthUnavailable(authError)) {'));
  });

  it('로그인 화면이 비밀번호 틀림과 다른 안내를 보인다', () => {
    expect(form).toContain('res.error === AUTH_UNAVAILABLE ? AUTH_UNAVAILABLE_MESSAGE');
    expect(AUTH_UNAVAILABLE).toBe('AUTH_UNAVAILABLE');
    expect(AUTH_UNAVAILABLE_MESSAGE).toContain('비밀번호가 틀린 것은 아닙니다');
  });
});
