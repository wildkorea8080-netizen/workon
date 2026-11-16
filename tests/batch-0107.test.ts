import { readFileSync } from 'fs';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/supabaseAdmin', () => ({ supabaseAdmin: {} }));
vi.mock('@/lib/supabase', () => ({ supabase: {} }));

import { readUserStatus, userSessionVerdict, type UserStatus } from '@/lib/middleware-db';
import { generateTempPassword, resetUserPassword, type PasswordResetDeps } from '@/lib/password-reset';
import { changeOwnPassword, type PasswordChangeDeps } from '@/lib/password-change';
import type { ThrottleDeps } from '@/lib/sign-in-throttle';

/**
 * 2026-11-16 — 비밀번호를 바꾸면 그 전에 로그인한 기기를 모두 끝낸다(0092), 관리자가 임시 비밀번호를 다시 내준다.
 * 예전엔 비밀번호를 바꿔도 다른 기기의 30일 로그인이 남았고, 잊은 직원은 다시 들어올 길이 없었다.
 */

const SUB = '11111111-2222-3333-4444-555555555555';
const DEPT = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
const CHANGED = Date.parse('2026-11-16T10:00:00.500Z');

describe('비밀번호 바꾼 뒤의 옛 로그인', () => {
  const status: UserStatus = { kind: 'active', role: 'USER', departmentId: DEPT, passwordChangedAt: CHANGED };
  const token = { sub: SUB, role: 'USER', departmentId: DEPT };
  const verdict = (t: Record<string, unknown>) => userSessionVerdict(new Map(), { ...token, ...t }, async () => status);

  it('바꾸기 전에 로그인한 토큰은 끝낸다(authAt 기준)', async () => {
    expect(await verdict({ authAt: CHANGED - 60_000 })).toBe('password_changed');
  });
  it('바꾼 뒤 로그인한 토큰·같은 초에 로그인한 토큰은 받는다', async () => {
    expect(await verdict({ authAt: CHANGED + 60_000 })).toBe('ok');
    expect(await verdict({ authAt: CHANGED - 400 })).toBe('ok'); // 같은 초(10:00:00)
  });
  it('세션을 다시 써 iat가 새로워져도 authAt이 있으면 authAt으로 본다', async () => {
    expect(await verdict({ authAt: CHANGED - 60_000, iat: Math.floor(CHANGED / 1000) + 3600 })).toBe('password_changed');
  });
  it('authAt 없는 옛 토큰은 iat(초)로, 둘 다 없으면 끝내지 않는다', async () => {
    expect(await verdict({ iat: Math.floor(CHANGED / 1000) - 10 })).toBe('password_changed');
    expect(await verdict({ iat: Math.floor(CHANGED / 1000) + 10 })).toBe('ok');
    expect(await verdict({})).toBe('ok');
  });
  it('바꾼 적이 없으면 그대로', async () => {
    const s: UserStatus = { kind: 'active', role: 'USER', departmentId: DEPT, passwordChangedAt: null };
    expect(await userSessionVerdict(new Map(), { ...token, authAt: 1 }, async () => s)).toBe('ok');
  });
  it('DB 칸을 읽어 밀리초로', async () => {
    const f = vi.fn(async () => ({ ok: true, json: async () => [{ role: 'USER', department_id: DEPT, password_changed_at: '2026-11-16T10:00:00.500Z' }] }));
    expect(await readUserStatus({ url: 'https://x', key: 'k' }, SUB, f)).toMatchObject({ passwordChangedAt: CHANGED });
  });
});

describe('본인 바꾸기도 바꾼 때를 적는다', () => {
  function deps(marked: boolean) {
    const throttle: ThrottleDeps = { countFailures: async () => 0, recordFailure: async () => {}, clearFailures: async () => {} };
    const d: PasswordChangeDeps = {
      throttle,
      readUser: async () => ({ email: 'a@x.go.kr', password_hash: null }),
      verifyAuth: async () => SUB,
      compareHash: async () => false,
      updateAuthPassword: async () => 'ok',
      hash: async (p) => p,
      setPasswordHash: async () => true,
      markPasswordChanged: vi.fn(async () => marked),
    };
    return d;
  }
  it('적으면 ok, 못 적어도 비밀번호는 바뀐 것 — 다른 로그인이 남았다고 알림', async () => {
    const d = deps(true);
    expect(await changeOwnPassword(d, { userId: SUB, current: 'Old-pass1', next: 'New-pass12', ip: null })).toEqual({ ok: true });
    expect(d.markPasswordChanged).toHaveBeenCalledWith(SUB, false);
    expect(await changeOwnPassword(deps(false), { userId: SUB, current: 'Old-pass1', next: 'New-pass12', ip: null })).toEqual({ ok: true, sessionsKept: true });
  });
});

describe('임시 비밀번호', () => {
  it('12자·대문자·소문자·숫자가 하나씩·헷갈리는 글자 없음', () => {
    for (let i = 0; i < 200; i++) {
      const p = generateTempPassword();
      expect(p).toHaveLength(12);
      expect(p).toMatch(/[A-Z]/);
      expect(p).toMatch(/[a-z]/);
      expect(p).toMatch(/[0-9]/);
      expect(p).not.toMatch(/[0O1lI]/);
    }
  });
  it('세 종류가 다 들지 않으면 다시 뽑는다', () => {
    let n = 0;
    // 첫 번은 모두 0('A'만) → 다시, 둘째는 0·24·48(대문자·소문자·숫자)
    const random = (k: number) => {
      n++;
      return Buffer.from(Array.from({ length: k }, (_, i) => (n === 1 ? 0 : [0, 24, 48][i % 3])));
    };
    const p = generateTempPassword(random);
    expect(n).toBe(2);
    expect(p).toBe('Aa3Aa3Aa3Aa3');
  });
});

describe('재발급', () => {
  function deps(o: { auth?: 'ok' | 'not_found' | 'error'; set?: boolean; mark?: boolean } = {}) {
    const calls: string[] = [];
    const d: PasswordResetDeps = {
      generate: () => 'Temp1234abcd',
      updateAuthPassword: async (_id, pw) => { calls.push(`auth:${pw}`); return o.auth ?? 'ok'; },
      hash: async (pw) => `h(${pw})`,
      setPasswordHash: async (_id, h) => { calls.push(`hash:${h}`); return o.set ?? true; },
      markPasswordChanged: async (_id, must) => { calls.push(must ? 'marked:must' : 'marked'); return o.mark ?? true; },
      unlock: async (email) => { calls.push(`unlock:${email}`); },
    };
    return { d, calls };
  }
  const target = { id: SUB, email: 'a@x.go.kr' };
  it('Auth·해시를 함께 바꾸고 바꾼 때를 적고 잠금을 푼다', async () => {
    const { d, calls } = deps();
    expect(await resetUserPassword(d, target)).toEqual({ ok: true, tempPassword: 'Temp1234abcd', sessionsKept: false });
    expect(calls).toEqual(['auth:Temp1234abcd', 'hash:h(Temp1234abcd)', 'marked:must', 'unlock:a@x.go.kr']);
  });
  it('Auth 계정이 없는(관리자가 등록한) 계정도 해시로', async () => {
    const { d } = deps({ auth: 'not_found' });
    expect(await resetUserPassword(d, target)).toMatchObject({ ok: true });
  });
  it('Auth 실패·해시 저장 실패는 실패, 바꾼 때를 못 적으면 sessionsKept', async () => {
    expect(await resetUserPassword(deps({ auth: 'error' }).d, target)).toEqual({ ok: false });
    expect(await resetUserPassword(deps({ set: false }).d, target)).toEqual({ ok: false });
    expect(await resetUserPassword(deps({ mark: false }).d, target)).toMatchObject({ ok: true, sessionsKept: true });
  });
});

describe('연결(원본)', () => {
  it('로그인할 때 authAt을 토큰에 넣는다', () => {
    const src = readFileSync('src/lib/nextAuthOptions.ts', 'utf8');
    expect(src).toMatch(/if \(user\) \{[\s\S]{0,400}token\.authAt = Date\.now\(\);/);
  });
  it('재발급 라우트 — 관리자·관리 범위·본인 아님·대리 접근 막음·비활성 막음·보안 로그 high(비밀번호 없음)', () => {
    const src = readFileSync('src/app/api/users/[id]/password-reset/route.ts', 'utf8');
    expect(src).toContain('isAdminSession(session)');
    expect(src).toContain('if (session.user.isImpersonating)');
    expect(src).toContain('if (params.id === session.user.id)');
    expect(src).toContain('managedDeptIds.includes(target.department_id)');
    expect(src).toContain(".eq('is_super_admin', false)");
    expect(src).toContain('if (target.is_active === false)');
    expect(src).toContain("logSecurityEvent(adminDeptId, session.user.id, 'password_reset_by_admin', { target_user_id: target.id, email_sent: mail.sent, sessions_kept: result.sessionsKept }, 'high')");
    expect(src).not.toMatch(/details: \{[^}]*tempPassword/);
  });
  it('화면·문구', () => {
    expect(readFileSync('src/components/admin/UsersManager.tsx', 'utf8')).toContain('`/api/users/${userId}/password-reset`');
    expect(readFileSync('src/components/auth/LoginForm.tsx', 'utf8')).toContain("redirectError === 'password_changed'");
    expect(readFileSync('src/app/my/password/page.tsx', 'utf8')).toContain("signOut({ callbackUrl: '/login?error=password_changed' })");
    expect(readFileSync('src/app/api/admin/audit-logs/route.ts', 'utf8')).toContain("password_reset_by_admin: '임시 비밀번호 재발급(관리자)'");
    expect(readFileSync('src/lib/mailer.ts', 'utf8')).toContain('export function sendPasswordResetEmail(');
  });
});

const url = process.env.WORK_TEST_DATABASE_URL;
describe.skipIf(!url)('0092 비밀번호 바꾼 때 (시험 DB)', () => {
  let db: pg.Client;
  beforeAll(async () => {
    if (/supabase\.(co|com)|pooler\./.test(url!)) throw new Error('운영 DB 주소로 보입니다 — 시험 DB를 쓰세요');
    db = new pg.Client({ connectionString: url });
    await db.connect();
    const sql = readFileSync('supabase/migrations/0092_password_changed_at.sql', 'utf8');
    await db.query(sql);
    await db.query(sql);
  });
  afterAll(async () => { await db?.end(); });
  it('users.password_changed_at timestamptz, 비어도 된다', async () => {
    const r = await db.query("SELECT data_type, is_nullable FROM information_schema.columns WHERE table_name = 'users' AND column_name = 'password_changed_at'");
    expect(r.rows[0]).toEqual({ data_type: 'timestamp with time zone', is_nullable: 'YES' });
  });
});
