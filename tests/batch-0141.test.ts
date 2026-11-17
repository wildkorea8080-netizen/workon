import { readFileSync } from 'fs';
import { describe, expect, it, vi } from 'vitest';
import { readSuperAdminState, superAdminActive, superAllowedWhileMustChange, superMustChange, type FetchLike } from '@/lib/middleware-db';

/**
 * 2026-11-17 — 임시 비밀번호로 만든 슈퍼관리자는 비밀번호부터 바꾸기. 예전엔 '슈퍼관리자 추가'가 준 임시 비밀번호(화면에 한 번 보임)를
 * 바꾸라고 막지 않아 그대로 계속 쓸 수 있었다. 직원(0093)과 같이 `password_must_change`를 참으로 두고, 미들웨어가 비밀번호 바꾸기
 * 화면(`/super/password`)·API만 열어 둔다.
 */

const ID = '11111111-1111-1111-1111-111111111111';
const cfg = { url: 'https://db.example', key: 'k' };
const ok = (rows: unknown) => ({ ok: true, json: async () => rows }) as unknown as Response;

describe('상태 읽기·기억', () => {
  it('password_must_change를 함께 읽는다', async () => {
    const urls: string[] = [];
    const f = (async (u: string) => { urls.push(u); return ok([{ is_super_admin: true, is_active: true, deleted_at: null, password_changed_at: null, password_must_change: true }]); }) as unknown as FetchLike;
    expect(await readSuperAdminState(cfg, ID, f)).toEqual({ status: 'active', changedAtMs: null, mustChange: true });
    expect(urls[0]).toContain('password_must_change');
    const g = (async () => ok([{ is_super_admin: true, is_active: true, deleted_at: null }])) as unknown as FetchLike;
    expect((await readSuperAdminState(cfg, ID, g)).mustChange).toBe(false);
  });
  it('superAdminActive가 기억한 값으로 superMustChange를 답한다(DB를 다시 안 부름)', async () => {
    const cache = new Map();
    const read = vi.fn(async () => ({ status: 'active' as const, changedAtMs: null, mustChange: true }));
    expect(await superAdminActive(cache, ID, read, 1_000)).toBe(true);
    expect(superMustChange(cache, ID)).toBe(true);
    expect(superMustChange(cache, 'other')).toBe(false);
    expect(superMustChange(cache, null)).toBe(false);
    expect(read).toHaveBeenCalledTimes(1);
  });
  it('기억한 값보다 새 토큰이면 다시 읽는다 — 바꾼 뒤 다시 로그인하면 곧바로 풀림', async () => {
    const cache = new Map();
    let must = true;
    const read = vi.fn(async () => ({ status: 'active' as const, changedAtMs: null, mustChange: must }));
    await superAdminActive(cache, ID, read, 1_000, 0);
    expect(superMustChange(cache, ID)).toBe(true);
    must = false;
    // 30초 안이어도 토큰이 기억보다 새것이면(iat 2초 > 기억 1초) 다시 읽음
    await superAdminActive(cache, ID, read, 5_000, 2);
    expect(read).toHaveBeenCalledTimes(2);
    expect(superMustChange(cache, ID)).toBe(false);
    // 같은 토큰으로는 30초 동안 기억으로
    await superAdminActive(cache, ID, read, 6_000, 2);
    expect(read).toHaveBeenCalledTimes(2);
  });
});

describe('열어 두는 경로', () => {
  it('비밀번호 바꾸기 화면·API·로그인·로그아웃만', () => {
    for (const p of ['/super/password', '/super/login', '/api/super/accounts/me/password', '/api/super/auth/logout', '/api/super/auth/login']) expect(superAllowedWhileMustChange(p), p).toBe(true);
    for (const p of ['/super', '/super/accounts', '/super/passwords', '/api/super/dashboard', '/api/super/accounts/super-admins', '/api/super/accounts/me/password2']) expect(superAllowedWhileMustChange(p), p).toBe(false);
  });
  it('미들웨어 — 화면은 /super/password로, API는 403', () => {
    const s = readFileSync('src/middleware.ts', 'utf8');
    expect(s).toContain("url.pathname = '/super/password'");
    expect(s).toContain("code: 'password_change_required'");
    expect(s.match(/superMustChange\(superStatusCache, superTokenSub\(superToken\)\) && !superAllowedWhileMustChange\(pathname\)/g)?.length).toBe(2);
  });
});

describe('슈퍼관리자 추가·화면', () => {
  it('추가하면 임시 비밀번호 표시를 켜고, 직원과 같은 임시 비밀번호 생성기를 쓴다', () => {
    const s = readFileSync('src/app/api/super/accounts/super-admins/route.ts', 'utf8');
    expect(s).toContain('generateTempPassword()');
    expect(s).toContain('password_must_change: true');
    expect(s).not.toContain('genTempPassword');
  });
  it('/super/password 화면은 같은 규칙으로 먼저 보고 바꾸면 로그인으로', () => {
    const s = readFileSync('src/app/super/password/page.tsx', 'utf8');
    expect(s).toContain('passwordPolicyError(form.next)');
    expect(s).toContain("'/api/super/accounts/me/password'");
    expect(s).toContain("window.location.href = '/super/login'");
  });
});
