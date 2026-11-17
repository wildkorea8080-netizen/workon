import { readFileSync } from 'fs';
import { describe, expect, it, vi } from 'vitest';
import { changeOwnPassword, type PasswordChangeDeps } from '@/lib/password-change';
import { type ThrottleDeps } from '@/lib/sign-in-throttle';
import { readSuperAdminState, readSuperAdminStatus, superAdminActive, superTokenIat, type FetchLike } from '@/lib/middleware-db';
import { ADMIN_LOG_ACTIONS } from '@/lib/super-admin-log-spec';

/**
 * 2026-11-17 — 슈퍼관리자 본인 비밀번호 바꾸기를 직원과 같은 길로. 예전엔 8자만 보고, 지금 비밀번호를 틀려도 실패로 세지 않았고,
 * Supabase Auth만 바꿔 `password_hash`가 있던 계정은 옛 비밀번호가 직원 로그인 두 번째 길로 계속 통과했으며,
 * 다른 기기의 슈퍼관리자 로그인(24시간 토큰)도 그대로였다.
 */

const ID = '11111111-1111-1111-1111-111111111111';

function deps(opts: { authOk?: string | null; failures?: number } = {}) {
  const scopes: string[] = [];
  const throttle: ThrottleDeps = {
    countFailures: vi.fn(async (s: string, field: string) => { scopes.push(`count:${s}`); return field === 'key_hash' ? opts.failures ?? 0 : 0; }),
    recordFailure: vi.fn(async (s: string) => { scopes.push(`fail:${s}`); }),
    clearFailures: vi.fn(async (s: string) => { scopes.push(`clear:${s}`); }),
  };
  const d: PasswordChangeDeps = {
    throttle,
    readUser: vi.fn(async () => ({ email: 'sa@x.kr', password_hash: 'old-hash', is_active: true, deleted_at: null })),
    verifyAuth: vi.fn(async () => (opts.authOk === undefined ? ID : opts.authOk)),
    compareHash: vi.fn(async () => false),
    updateAuthPassword: vi.fn(async () => 'ok' as const),
    hash: vi.fn(async (pw: string) => `h(${pw})`),
    setPasswordHash: vi.fn(async () => true),
    markPasswordChanged: vi.fn(async () => true),
  };
  return { d, scopes };
}

describe('잠금 범위 — 슈퍼관리자 포털에서 바꾸면 슈퍼관리자 로그인과 같은 셈', () => {
  it("틀리면 'super' 범위 실패로 센다", async () => {
    const { d, scopes } = deps({ authOk: null });
    const r = await changeOwnPassword(d, { userId: ID, current: 'Wrong-pw1', next: 'New-pass-12', ip: '1.2.3.4', scope: 'super' });
    expect(r).toMatchObject({ ok: false, code: 'wrong' });
    expect(scopes).toContain('fail:super');
    expect(scopes.some((s) => s.endsWith(':user'))).toBe(false);
  });
  it('잠긴 슈퍼관리자 계정은 확인하지 않음', async () => {
    const { d } = deps({ failures: 5 });
    expect(await changeOwnPassword(d, { userId: ID, current: 'x', next: 'New-pass-12', ip: null, scope: 'super' })).toMatchObject({ ok: false, code: 'locked' });
    expect(d.verifyAuth).not.toHaveBeenCalled();
  });
  it('맞으면 Auth와 옛 해시를 둘 다 바꾸고 바꾼 때를 적음', async () => {
    const { d, scopes } = deps();
    expect(await changeOwnPassword(d, { userId: ID, current: 'Old-pw-12', next: 'New-pass-12', ip: null, scope: 'super' })).toEqual({ ok: true });
    expect(d.updateAuthPassword).toHaveBeenCalledWith(ID, 'New-pass-12');
    expect(d.setPasswordHash).toHaveBeenCalledWith(ID, 'h(New-pass-12)');
    expect(d.markPasswordChanged).toHaveBeenCalledWith(ID, false);
    expect(scopes).toContain('clear:super');
  });
  it('규칙은 직원과 같다(8자 소문자만은 거절)', async () => {
    const { d } = deps();
    expect(await changeOwnPassword(d, { userId: ID, current: 'Old-pw-12', next: 'abcdefgh', ip: null, scope: 'super' })).toMatchObject({ ok: false, code: 'policy' });
  });
  it('범위를 안 주면 예전처럼 직원(user)', async () => {
    const { d, scopes } = deps({ authOk: null });
    await changeOwnPassword(d, { userId: ID, current: 'Wrong-pw1', next: 'New-pass-12', ip: null });
    expect(scopes).toContain('fail:user');
  });
});

describe('미들웨어 — 비밀번호를 바꾼 때보다 앞서 받은 슈퍼관리자 토큰은 끝', () => {
  const cfg = { url: 'https://db.example', key: 'k' };
  const ok = (rows: unknown) => ({ ok: true, json: async () => rows }) as unknown as Response;
  const changedAt = '2026-11-17T13:00:00.000Z';
  const changedSec = Date.parse(changedAt) / 1000;

  it('상태와 바꾼 때를 함께 읽고, 옛 함수는 상태만', async () => {
    const f = (async () => ok([{ is_super_admin: true, is_active: true, deleted_at: null, password_changed_at: changedAt }])) as unknown as FetchLike;
    expect(await readSuperAdminState(cfg, ID, f)).toEqual({ status: 'active', changedAtMs: Date.parse(changedAt) });
    expect(await readSuperAdminStatus(cfg, ID, f)).toBe('active');
    const g = (async () => ok([{ is_super_admin: true, is_active: true, deleted_at: null, password_changed_at: null }])) as unknown as FetchLike;
    expect(await readSuperAdminState(cfg, ID, g)).toEqual({ status: 'active', changedAtMs: null });
  });
  it('바꾼 뒤에 받은 토큰은 그대로, 앞선 토큰은 끝(같은 초는 그대로)', async () => {
    const read = async () => ({ status: 'active' as const, changedAtMs: Date.parse(changedAt) });
    expect(await superAdminActive(new Map(), ID, read, 1_000, changedSec - 60)).toBe(false);
    expect(await superAdminActive(new Map(), ID, read, 1_000, changedSec)).toBe(true);
    expect(await superAdminActive(new Map(), ID, read, 1_000, changedSec + 5)).toBe(true);
    // 토큰 때를 안 주면(대리 접근 확인) 상태만
    expect(await superAdminActive(new Map(), ID, read, 1_000)).toBe(true);
  });
  it('기억한 값으로도 같은 판정, DB를 못 읽을 때도', async () => {
    const cache = new Map();
    const read = vi.fn(async () => ({ status: 'active' as const, changedAtMs: Date.parse(changedAt) }));
    expect(await superAdminActive(cache, ID, read, 1_000, changedSec + 1)).toBe(true);
    expect(await superAdminActive(cache, ID, read, 2_000, changedSec - 1)).toBe(false); // 30초 안 — 기억으로
    expect(read).toHaveBeenCalledTimes(1);
    const err = async () => 'error' as const;
    expect(await superAdminActive(cache, ID, err, 60_000, changedSec - 1)).toBe(false);
    expect(await superAdminActive(cache, ID, err, 60_000, changedSec + 1)).toBe(true);
  });
  it('토큰의 iat 꺼내기', () => {
    const tok = (p: object) => `h.${Buffer.from(JSON.stringify(p)).toString('base64url')}.s`;
    expect(superTokenIat(tok({ sub: ID, iat: 1763380800 }))).toBe(1763380800);
    expect(superTokenIat(tok({ sub: ID }))).toBeUndefined();
    expect(superTokenIat('garbage')).toBeUndefined();
  });
  it('미들웨어가 슈퍼관리자 토큰에 iat를 넘긴다', () => {
    const s = readFileSync('src/middleware.ts', 'utf8');
    expect(s).toContain('readSuperAdminState(restConfig(), sub, fetch), Date.now(), superTokenIat(token))');
  });
});

describe('라우트·화면', () => {
  const route = readFileSync('src/app/api/super/accounts/me/password/route.ts', 'utf8');
  it("직원과 같은 changeOwnPassword를 'super' 범위로, 조작 기록, 쿠키 지움", () => {
    expect(route).toContain("scope: 'super'");
    expect(route).toContain("action: 'super_admin_password_changed'");
    expect(route).toMatch(/maxAge: 0/);
    expect(route).not.toMatch(/process\.env\.NEXT_PUBLIC_SUPABASE/);
    expect(route.slice(route.indexOf("writeAuditRow('super_admin_logs'"), route.indexOf("'super_admin_password_changed');"))).not.toMatch(/currentPassword|newPassword|password:/);
    expect(ADMIN_LOG_ACTIONS.super_admin_password_changed).toBeTruthy();
  });
  it('화면은 같은 규칙을 먼저 보고, 끝나면 로그인으로', () => {
    const s = readFileSync('src/app/super/accounts/page.tsx', 'utf8');
    expect(s).toContain('passwordPolicyError(pwForm.next)');
    expect(s).toContain("window.location.href = '/super/login'");
    expect(s).not.toContain("setPwError('8자 이상 입력하세요.')");
  });
});
