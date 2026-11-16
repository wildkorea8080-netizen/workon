import { readFileSync } from 'fs';
import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * 2026-11-17 — 로그인·비밀번호 쪽 쓰기 실패를 운영 기록에.
 * Supabase는 실패를 던지지 않고 `{ error }`로 돌려준다 — 결과를 보지 않던 곳에서 실패가 조용히 사라졌다:
 * 로그인 실패를 못 세면 잠금이 걸리지 않고, 마지막 로그인 시각을 못 적으면 장기 미접속 잠금이 잘못 걸리고,
 * 비밀번호를 바꾼 뒤 남은 재설정 링크를 못 끝내면 그 링크가 기한까지 쓰인다.
 */

const db = vi.hoisted(() => ({ error: null as { code: string } | null, logs: [] as Array<{ level: string; category: string; message: string; details?: Record<string, unknown> }> }));

vi.mock('@/lib/supabaseAdmin', () => {
  // 어떤 사슬이든 마지막에 { error }를 돌려주는 가짜
  const result = () => ({ data: null, error: db.error });
  const chain: Record<string, unknown> = {};
  const self = new Proxy(chain, {
    get(_t, prop) {
      if (prop === 'then') return (resolve: (v: unknown) => void) => resolve(result());
      return () => self;
    },
  });
  return { supabaseAdmin: { from: () => self } };
});
vi.mock('@/lib/logger', () => ({ logSystem: vi.fn(async (p) => { db.logs.push(p); }) }));
vi.mock('@/lib/supabase', () => ({ supabase: {} }));

import { FAILURE_NOT_RECORDED, FAILURES_NOT_CLEARED, noteSignInFailure, noteSignInSuccess, throttleDeps, type ThrottleDeps } from '@/lib/sign-in-throttle';
import { INVITATION_NOT_RELEASED, releaseInvitation } from '@/lib/invitation-claim';
import { LAST_SIGN_IN_NOT_SAVED, signInRecordDeps } from '@/lib/sign-in-record';
import { OPEN_LINKS_NOT_EXPIRED, TOKEN_NOT_RELEASED, confirmPasswordReset, requestPasswordReset, tokenHash, type ResetDeps, type ResetUser } from '@/lib/password-reset-mail';

beforeEach(() => { db.error = null; db.logs = []; });

describe('로그인 실패 잠금 — 기록을 못 남기면 운영 기록에', () => {
  const failing = (): ThrottleDeps => ({
    countFailures: async () => 0,
    recordFailure: async () => { throw { code: '42P01' }; },
    clearFailures: async () => { throw { code: '42P01' }; },
  });
  it('실패를 못 세면 error·security(잠금이 걸리지 않을 수 있음), 던지지 않음', async () => {
    await expect(noteSignInFailure(failing(), 'user', 'kim@x.go.kr', '1.2.3.4')).resolves.toBeUndefined();
    expect(db.logs).toEqual([{ level: 'error', category: 'security', message: FAILURE_NOT_RECORDED, details: { scope: 'user', code: '42P01' } }]);
    expect(JSON.stringify(db.logs)).not.toContain('kim@');
  });
  it('성공 뒤 실패 기록을 못 지우면 warning', async () => {
    await noteSignInSuccess(failing(), 'super', 'a@x.kr');
    expect(db.logs[0]).toMatchObject({ level: 'warning', category: 'security', message: FAILURES_NOT_CLEARED, details: { scope: 'super' } });
  });
  it('실제 의존은 돌려준 오류를 던진다(예전엔 그냥 지나갔다)', async () => {
    db.error = { code: '42P01' };
    await expect(throttleDeps().recordFailure('user', 'k'.repeat(64), null)).rejects.toMatchObject({ code: '42P01' });
    await expect(throttleDeps().clearFailures('user', 'k'.repeat(64))).rejects.toMatchObject({ code: '42P01' });
    db.error = null;
    await expect(throttleDeps().recordFailure('user', 'k'.repeat(64), null)).resolves.toBeUndefined();
  });
});

describe('마지막 로그인 시각·초대 차지 풀기', () => {
  it('마지막 로그인 시각을 못 적으면 error·auth(장기 미접속 잠금이 잘못 걸릴 수 있음)', async () => {
    db.error = { code: '42703' };
    await signInRecordDeps().touchLastSignIn('u1', '2026-11-17T00:00:00Z');
    expect(db.logs).toEqual([{ level: 'error', category: 'auth', message: LAST_SIGN_IN_NOT_SAVED, details: { user_id: 'u1', code: '42703' } }]);
    db.error = null; db.logs = [];
    await signInRecordDeps().touchLastSignIn('u1', '2026-11-17T00:00:00Z');
    expect(db.logs).toEqual([]);
  });
  it('초대 차지를 못 풀면 warning(새 초대 필요), 던지지 않음', async () => {
    db.error = { code: 'PGRST' };
    await expect(releaseInvitation('i1', '2026-11-17T00:00:00Z')).resolves.toBeUndefined();
    expect(db.logs).toEqual([{ level: 'warning', category: 'auth', message: INVITATION_NOT_RELEASED, details: { invitation_id: 'i1', code: 'PGRST' } }]);
    db.error = null; db.logs = [];
    await releaseInvitation('i1', '2026-11-17T00:00:00Z');
    expect(db.logs).toEqual([]);
  });
});

describe('비밀번호 재설정 링크 — 끝내지 못하면 운영 기록에', () => {
  const NOW = new Date('2026-11-17T01:00:00Z');
  const TOKEN = 'A'.repeat(43);
  const USER: ResetUser = { id: 'u1', email: 'kim@x.go.kr', full_name: '김주무관', department_id: 'd1', password_hash: null, is_active: true, deleted_at: null, is_super_admin: false };
  function deps(o: { expireFails?: boolean; releaseFails?: boolean; auth?: 'ok' | 'error' } = {}) {
    const logs: Array<[string, Record<string, unknown>]> = [];
    const d: ResetDeps = {
      mailConfigured: () => true,
      findUserByEmail: async () => USER,
      readUser: async () => USER,
      countRequests: async () => 0,
      insertRequest: async () => 'r1',
      expireOpen: async () => { if (o.expireFails) throw new Error('db'); },
      findToken: async (h) => (h === tokenHash(TOKEN) ? { id: 'r1', user_id: 'u1', expires_at: '2026-11-17T01:30:00Z', used_at: null } : null),
      claimToken: async () => true,
      releaseToken: async () => { if (o.releaseFails) throw new Error('db'); },
      unlock: async () => {},
      sendLink: async () => true,
      newToken: () => TOKEN,
      log: async (m, details) => { logs.push([m, details]); },
      updateAuthPassword: async () => o.auth ?? 'ok',
      hash: async (p) => `h(${p})`,
      setPasswordHash: async () => true,
      markPasswordChanged: async () => true,
    };
    return { d, logs };
  }
  it('바꾼 뒤 남은 링크를 끝내지 못하면 기록(바꾸기는 성공)', async () => {
    const { d, logs } = deps({ expireFails: true });
    expect(await confirmPasswordReset(d, { token: TOKEN, next: 'Abcdef12!x' }, NOW)).toMatchObject({ ok: true });
    expect(logs).toEqual([[OPEN_LINKS_NOT_EXPIRED, { user_id: 'u1', step: 'confirm' }]]);
  });
  it('새 링크를 보낼 때 앞 링크를 끝내지 못해도 기록(응답은 그대로)', async () => {
    const { d, logs } = deps({ expireFails: true });
    expect(await requestPasswordReset(d, { email: 'kim@x.go.kr', ip: null }, NOW)).toEqual({ ok: true });
    expect(logs).toEqual([[OPEN_LINKS_NOT_EXPIRED, { user_id: 'u1', step: 'request' }]]);
  });
  it('바꾸기 실패 뒤 열쇠를 못 돌려놓으면 기록', async () => {
    const { d, logs } = deps({ auth: 'error', releaseFails: true });
    expect(await confirmPasswordReset(d, { token: TOKEN, next: 'Abcdef12!x' }, NOW)).toEqual({ ok: false, code: 'error' });
    expect(logs).toEqual([[TOKEN_NOT_RELEASED, { user_id: 'u1' }]]);
  });
  it('기록에 이메일·열쇠가 없다', async () => {
    const { d, logs } = deps({ expireFails: true });
    await confirmPasswordReset(d, { token: TOKEN, next: 'Abcdef12!x' }, NOW);
    expect(JSON.stringify(logs)).not.toContain('kim@');
    expect(JSON.stringify(logs)).not.toContain(TOKEN);
  });
});

describe('원본 — 결과를 보는지', () => {
  it('재설정 의존이 expireOpen·releaseToken의 오류를 던진다', () => {
    const src = readFileSync('src/lib/password-reset-mail.ts', 'utf8');
    expect(src).toMatch(/const \{ error \} = await q;\s*if \(error\) throw error;/);
    expect(src).toMatch(/update\(\{ used_at: null \}\)\.eq\('id', id\);\s*if \(error\) throw error;/);
  });
  it('슈퍼관리자 기관 API 키 저장이 세 쓰기의 오류를 보고 500(예전엔 실패해도 ok)', () => {
    const src = readFileSync('src/app/api/super/organizations/[id]/api-keys/route.ts', 'utf8');
    expect(src.match(/KEY_SAVE_FAILED \}, \{ status: 500 \}/g)?.length).toBe(3);
    expect(src).not.toMatch(/^\s*await supabaseAdmin\s*$/m);
    expect(src).not.toMatch(/^\s*await supabaseAdmin\.from\('api_keys'\)/m);
  });
  it('운영 기록마저 못 남기면 함수 로그에(문구·코드만)', () => {
    const src = readFileSync('src/lib/logger.ts', 'utf8');
    expect(src).toContain("console.error('[system_logs 기록 실패]'");
  });
});
