import { beforeEach, describe, expect, it, vi } from 'vitest';
import bcrypt from 'bcryptjs';

/**
 * 2026-11-20 — 로그인이 '지금 확인하지 못한 것'을 틀린 비밀번호로 세지 않는다. 실제 로그인 함수(`authOptions`의 authorize)를 돌려 본다.
 * ① 인증 서비스(Auth)가 응답하지 않음(0239) ② **저장해 둔 비밀번호(users)를 못 읽음**(이번) — 관리자가 등록한 계정은 Auth에 없어
 *    이 길로만 들어오는데, users 읽기가 실패하면 '틀림'으로 세어 30분 5번에 계정이, 사무실 주소 하나면 30번에 기관 전체가 잠겼다.
 * 둘 다 이제 실패로 세지 않고 `AUTH_UNAVAILABLE`을 던진다(화면 '비밀번호가 틀린 것은 아닙니다'). 정말 틀리면 예전처럼 센다.
 */

const state = vi.hoisted(() => ({
  auth: { data: { user: null }, error: { status: 400, code: 'invalid_credentials', message: 'Invalid login credentials' } } as { data: { user: unknown }; error: unknown },
  usersRow: null as unknown, usersError: null as unknown,
  failures: [] as string[], successes: [] as string[], records: [] as string[],
}));

vi.mock('@/lib/config', async (orig) => ({ ...(await orig<typeof import('@/lib/config')>()), NEXTAUTH_SECRET: 'x' }));
vi.mock('@/lib/logger', () => ({ logSystem: vi.fn(async () => {}) }));
vi.mock('@/lib/supabase', () => ({ supabase: { auth: { signInWithPassword: async () => state.auth } } }));
vi.mock('@/lib/supabaseAdmin', () => ({
  supabaseAdmin: {
    from: () => {
      const b: Record<string, unknown> = {};
      for (const n of ['select', 'eq']) b[n] = () => b;
      b.maybeSingle = async () => ({ data: state.usersError ? null : state.usersRow, error: state.usersError });
      return b;
    },
  },
}));
vi.mock('@/lib/sign-in-throttle', async (orig) => ({
  ...(await orig<typeof import('@/lib/sign-in-throttle')>()),
  throttleDeps: () => ({}),
  signInLock: async () => null,
  noteSignInFailure: async (_d: unknown, _s: unknown, email: string) => { state.failures.push(email); },
  noteSignInSuccess: async (_d: unknown, _s: unknown, email: string) => { state.successes.push(email); },
}));
vi.mock('@/lib/sign-in-record', () => ({
  signInRecordDeps: () => ({}),
  recordSignIn: async (_d: unknown, input: { outcome: string }) => { state.records.push(input.outcome); },
}));
vi.mock('@/lib/dormant-lock', () => ({ dormantDeps: () => ({}), lockIfDormant: async () => false }));

import { authOptions } from '@/lib/nextAuthOptions';
import { AUTH_UNAVAILABLE } from '@/lib/auth-unavailable';

const authorize = (password = 'Pass-word1') =>
  (authOptions.providers[0] as unknown as { options: { authorize: (c: unknown, r: unknown) => Promise<unknown> } })
    .options.authorize({ email: 'kim@org.go.kr', password }, { headers: {} });

const HASH = bcrypt.hashSync('Pass-word1', 4);
const localUser = { id: 'u1', email: 'kim@org.go.kr', role: 'USER', full_name: '김', department_id: 'd1', password_hash: HASH, is_active: true, deleted_at: null };

beforeEach(() => {
  state.auth = { data: { user: null }, error: { status: 400, code: 'invalid_credentials', message: 'Invalid login credentials' } };
  state.usersRow = null; state.usersError = null;
  state.failures = []; state.successes = []; state.records = [];
});

describe('저장해 둔 비밀번호로 들어오는 계정(관리자가 등록)', () => {
  it('사용자를 못 읽으면 실패로 세지 않고 AUTH_UNAVAILABLE', async () => {
    state.usersError = { code: '57014', message: 'timeout' };
    await expect(authorize()).rejects.toThrow(AUTH_UNAVAILABLE);
    expect(state.failures).toEqual([]);
    expect(state.records).not.toContain('login_failed');
  });
  it('맞으면 들어온다', async () => {
    state.usersRow = localUser;
    expect(await authorize()).toMatchObject({ id: 'u1', departmentId: 'd1' });
    expect(state.successes).toEqual(['kim@org.go.kr']);
    expect(state.failures).toEqual([]);
  });
  it('틀리면 예전처럼 실패로 센다', async () => {
    state.usersRow = localUser;
    expect(await authorize('Wrong-pass1')).toBeNull();
    expect(state.failures).toEqual(['kim@org.go.kr']);
    expect(state.records).toContain('login_failed');
  });
  it('계정이 없으면 예전처럼 실패로 센다', async () => {
    expect(await authorize()).toBeNull();
    expect(state.failures).toEqual(['kim@org.go.kr']);
  });
});

describe('인증 서비스가 응답하지 않음(0239)', () => {
  it('저장해 둔 비밀번호도 없으면 실패로 세지 않고 AUTH_UNAVAILABLE', async () => {
    state.auth = { data: { user: null }, error: { name: 'AuthRetryableFetchError', status: 0, message: 'fetch failed' } };
    await expect(authorize()).rejects.toThrow(AUTH_UNAVAILABLE);
    expect(state.failures).toEqual([]);
  });
  it('저장해 둔 비밀번호로 맞으면 그대로 들어온다', async () => {
    state.auth = { data: { user: null }, error: { status: 503, message: 'unavailable' } };
    state.usersRow = localUser;
    expect(await authorize()).toMatchObject({ id: 'u1' });
    expect(state.failures).toEqual([]);
  });
});
