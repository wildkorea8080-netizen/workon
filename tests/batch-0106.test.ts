import { readFileSync } from 'fs';
import { describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/supabaseAdmin', () => ({ supabaseAdmin: {} }));
vi.mock('@/lib/supabase', () => ({ supabase: {} }));

import { PASSWORD_MAX_BYTES, passwordPolicyError } from '@/lib/password-policy';
import { changeOwnPassword, type PasswordChangeDeps } from '@/lib/password-change';
import { LOCK_FAILURES, signInKey, type ThrottleDeps } from '@/lib/sign-in-throttle';

/** 2026-11-16 — 직원이 자기 비밀번호를 바꾼다. 예전에는 관리자가 준 임시 비밀번호를 계속 써야 했다 */

const ID = '11111111-2222-3333-4444-555555555555';

describe('비밀번호 규칙', () => {
  it('세 종류 8자·두 종류 10자', () => {
    expect(passwordPolicyError('Abcdef1!')).toBeNull();
    expect(passwordPolicyError('abcdef12')).toMatch(/세 종류/); // 두 종류 8자
    expect(passwordPolicyError('abcdefgh12')).toBeNull(); // 두 종류 10자
    expect(passwordPolicyError('abcdefghij')).toMatch(/세 종류/); // 한 종류
    expect(passwordPolicyError('Ab1!')).toMatch(/세 종류/);
  });
  it('공백·너무 긴 것·같은 글자 연속·이메일 아이디는 안 됨', () => {
    expect(passwordPolicyError('Abc def1!')).toMatch(/공백/);
    expect(passwordPolicyError('Aa1!' + '가'.repeat(30))).toMatch(new RegExp(`${PASSWORD_MAX_BYTES}바이트`)); // 4 + 90바이트
    expect(passwordPolicyError('Aaaaa1!xy')).toMatch(/네 번/);
    expect(passwordPolicyError('Hong1234!', { email: 'hong1234@x.go.kr' })).toMatch(/이메일 아이디/);
    expect(passwordPolicyError('Hgd1234!x', { email: 'abc@x.go.kr' })).toBeNull(); // 3자 아이디는 보지 않음
    expect(passwordPolicyError('')).toMatch(/입력/);
    expect(passwordPolicyError(undefined)).toMatch(/입력/);
  });
});

type Row = Awaited<ReturnType<PasswordChangeDeps['readUser']>>;

function makeDeps(opts: {
  row?: Row;
  authOk?: string | null;
  hashOk?: boolean;
  auth?: 'ok' | 'not_found' | 'error';
  setOk?: boolean;
  failures?: number;
} = {}) {
  const calls: string[] = [];
  const throttle: ThrottleDeps = {
    countFailures: vi.fn(async (_s: string, field: string) => (field === 'key_hash' ? opts.failures ?? 0 : 0)),
    recordFailure: vi.fn(async (_s: string, key: string) => { calls.push(`fail:${key}`); }),
    clearFailures: vi.fn(async (_s: string, key: string) => { calls.push(`clear:${key}`); }),
  };
  const d: PasswordChangeDeps = {
    throttle,
    readUser: vi.fn(async () => (opts.row === undefined ? { email: 'a@x.go.kr', password_hash: null, is_active: true, deleted_at: null } : opts.row)),
    verifyAuth: vi.fn(async () => (opts.authOk === undefined ? ID : opts.authOk)),
    compareHash: vi.fn(async () => opts.hashOk ?? false),
    updateAuthPassword: vi.fn(async (_id: string, pw: string) => { calls.push(`auth:${pw}`); return opts.auth ?? 'ok'; }),
    hash: vi.fn(async (pw: string) => `h(${pw})`),
    setPasswordHash: vi.fn(async (_id: string, h: string) => { calls.push(`hash:${h}`); return opts.setOk ?? true; }),
    markPasswordChanged: vi.fn(async () => { calls.push('marked'); return true; }),
  };
  return { d, calls };
}
const run = (d: PasswordChangeDeps, current: unknown = 'Old-pass1', next: unknown = 'New-pass12') =>
  changeOwnPassword(d, { userId: ID, current, next, ip: '1.2.3.4' });

describe('비밀번호 바꾸기', () => {
  it('Auth 계정 — 지금 비밀번호를 Auth로 확인하고 Auth만 바꾼다(해시가 없으면 해시는 그대로)', async () => {
    const { d, calls } = makeDeps();
    expect(await run(d)).toEqual({ ok: true });
    expect(d.verifyAuth).toHaveBeenCalledWith('a@x.go.kr', 'Old-pass1');
    expect(calls).toEqual([`clear:${signInKey('a@x.go.kr')}`, 'auth:New-pass12', 'marked']);
  });
  it('Auth 계정에 옛 해시도 있으면 해시도 새 비밀번호로 — 옛 비밀번호가 두 번째 길로 통과하지 않게', async () => {
    const { d, calls } = makeDeps({ row: { email: 'a@x.go.kr', password_hash: 'old', is_active: true } });
    expect(await run(d)).toEqual({ ok: true });
    expect(calls.slice(1)).toEqual(['auth:New-pass12', 'hash:h(New-pass12)', 'marked']);
  });
  it('관리자가 등록한 계정(Auth 없음) — 해시로 확인하고 해시를 바꾼다', async () => {
    const { d, calls } = makeDeps({ row: { email: 'a@x.go.kr', password_hash: 'old' }, authOk: null, hashOk: true, auth: 'not_found' });
    expect(await run(d)).toEqual({ ok: true });
    expect(d.compareHash).toHaveBeenCalledWith('Old-pass1', 'old');
    expect(calls.slice(1)).toEqual(['auth:New-pass12', 'hash:h(New-pass12)', 'marked']);
  });
  it('Auth가 다른 계정 id를 돌려주면 본인 확인이 아니다', async () => {
    const { d } = makeDeps({ authOk: 'other-id' });
    expect(await run(d)).toMatchObject({ ok: false, code: 'wrong' });
  });
  it('지금 비밀번호가 틀리면 로그인 실패로 세고 아무것도 바꾸지 않는다', async () => {
    const { d, calls } = makeDeps({ authOk: null, hashOk: false });
    expect(await run(d)).toMatchObject({ ok: false, code: 'wrong' });
    expect(calls).toEqual([`fail:${signInKey('a@x.go.kr')}`]);
  });
  it('잠긴 계정은 확인하지도 않는다', async () => {
    const { d } = makeDeps({ failures: LOCK_FAILURES });
    expect(await run(d)).toEqual({ ok: false, code: 'locked' });
    expect(d.verifyAuth).not.toHaveBeenCalled();
  });
  it('규칙·같은 비밀번호·빈 지금 비밀번호는 확인 전에 막는다', async () => {
    let m = makeDeps();
    expect(await run(m.d, 'Old-pass1', 'short')).toMatchObject({ ok: false, code: 'policy' });
    m = makeDeps();
    expect(await run(m.d, 'Same-pass12', 'Same-pass12')).toMatchObject({ ok: false, code: 'same' });
    m = makeDeps();
    expect(await run(m.d, '', 'New-pass12')).toMatchObject({ ok: false, code: 'wrong' });
    expect(m.d.verifyAuth).not.toHaveBeenCalled();
  });
  it('비활성·탈퇴·없는 계정·읽기 실패', async () => {
    expect(await run(makeDeps({ row: { email: 'a@x.go.kr', password_hash: null, is_active: false } }).d)).toEqual({ ok: false, code: 'not_found' });
    expect(await run(makeDeps({ row: { email: 'a@x.go.kr', password_hash: null, deleted_at: '2026-11-01' } }).d)).toEqual({ ok: false, code: 'not_found' });
    expect(await run(makeDeps({ row: null }).d)).toEqual({ ok: false, code: 'not_found' });
    expect(await run(makeDeps({ row: 'error' }).d)).toEqual({ ok: false, code: 'error' });
  });
  it('Auth 바꾸기·해시 저장 실패는 error', async () => {
    expect(await run(makeDeps({ auth: 'error' }).d)).toEqual({ ok: false, code: 'error' });
    expect(await run(makeDeps({ row: { email: 'a@x.go.kr', password_hash: 'old' }, setOk: false }).d)).toEqual({ ok: false, code: 'error' });
  });
});

describe('연결(원본)', () => {
  it('라우트 — 세션 본인만·대리 접근 막음·보안 로그에 비밀번호 없음', () => {
    const src = readFileSync('src/app/api/my/password/route.ts', 'utf8');
    expect(src).toContain('userId: session.user.id');
    expect(src).not.toMatch(/body\??\.(user_?id|id)\b/);
    expect(src).toContain('if (session.user.isImpersonating)');
    expect(src).toContain("logSecurityEvent(session.user.departmentId ?? null, session.user.id, 'password_changed'");
    expect(src).toContain("'password_changed', result.sessionsKept ? { sessions_kept: true } : {}, 'low')");
    expect(src).toContain('locked: [429, LOCKED_MESSAGE]');
  });
  it('화면 — 규칙은 잎 파일에서, 사용자 메뉴에 링크, 감사 화면 이름표', () => {
    const page = readFileSync('src/app/my/password/page.tsx', 'utf8');
    expect(page).toContain("from '@/lib/password-policy'");
    expect(page).not.toContain("from '@/lib/password-change'");
    expect(page).toContain("fetch('/api/my/password'");
    expect(readFileSync('src/lib/password-policy.ts', 'utf8')).not.toMatch(/^import /m);
    expect(readFileSync('src/components/layout/UserMenu.tsx', 'utf8')).toContain('href="/my/password"');
    expect(readFileSync('src/lib/security-event-text.ts', 'utf8')).toContain("password_changed: '비밀번호 바꾸기(본인)'");
  });
});
