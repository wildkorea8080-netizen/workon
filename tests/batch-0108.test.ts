import { readFileSync } from 'fs';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { allowedWhileMustChange, readUserStatus, userSessionVerdict, type UserStatus } from '@/lib/middleware-db';

/**
 * 2026-11-16 — 관리자가 준 임시 비밀번호(등록·일괄 등록·재발급)로는 비밀번호부터 바꾸게 한다(0093).
 * 예전엔 '바꿔 주세요'라는 안내뿐이라 임시 비밀번호를 그대로 계속 쓸 수 있었다. 슈퍼관리자도 재발급할 수 있다.
 */

const SUB = '11111111-2222-3333-4444-555555555555';
const DEPT = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';

describe('임시 비밀번호 판정', () => {
  const must: UserStatus = { kind: 'active', role: 'USER', departmentId: DEPT, passwordChangedAt: null, mustChangePassword: true };
  const token = { sub: SUB, role: 'USER', departmentId: DEPT };
  it('바꿔야 하면 must_change_password', async () => {
    expect(await userSessionVerdict(new Map(), token, async () => must)).toBe('must_change_password');
  });
  it('대리 접근 토큰은 묶지 않는다(슈퍼관리자가 그 관리자 대신 바꾸지 않음)', async () => {
    expect(await userSessionVerdict(new Map(), { ...token, isImpersonating: true }, async () => must)).toBe('ok');
  });
  it('비활성·권한 바뀜·비밀번호 바뀜이 먼저다', async () => {
    expect(await userSessionVerdict(new Map(), token, async () => ({ kind: 'inactive' }))).toBe('inactive');
    expect(await userSessionVerdict(new Map(), { ...token, role: 'ADMIN' }, async () => must)).toBe('changed');
    const changed: UserStatus = { ...must, passwordChangedAt: Date.parse('2026-11-16T10:00:00Z') } as UserStatus;
    expect(await userSessionVerdict(new Map(), { ...token, authAt: Date.parse('2026-11-16T09:00:00Z') }, async () => changed)).toBe('password_changed');
  });
  it('DB 칸 — 참일 때만 참', async () => {
    const read = (v: unknown) => readUserStatus({ url: 'https://x', key: 'k' }, SUB, vi.fn(async (_u: string) => ({ ok: true, json: async () => [{ role: 'USER', department_id: DEPT, password_must_change: v }] })));
    expect(await read(true)).toMatchObject({ mustChangePassword: true });
    expect(await read(false)).toMatchObject({ mustChangePassword: false });
    expect(await read(null)).toMatchObject({ mustChangePassword: false });
  });
});

describe('열어 두는 길', () => {
  it('비밀번호 바꾸기·로그인 화면·점검·차단·브랜딩만', () => {
    for (const p of ['/my/password', '/my/password?x', '/api/my/password', '/login', '/signin/org', '/signup', '/register', '/maintenance', '/blocked', '/api/branding', '/api/branding/logo', '/api/system/maintenance']) {
      expect(allowedWhileMustChange(p.split('?')[0]), p).toBe(true);
    }
    for (const p of ['/', '/chat', '/admin', '/api/chat', '/api/users', '/my/stats', '/my/passwords', '/api/my/stats', '/loginx']) {
      expect(allowedWhileMustChange(p), p).toBe(false);
    }
  });
});

describe('연결(원본)', () => {
  const mw = readFileSync('src/middleware.ts', 'utf8');
  it('미들웨어 — 로그인은 살리고 화면은 비밀번호 바꾸기로, API는 403', () => {
    expect(mw).toContain("if (verdict === 'must_change_password') {");
    expect(mw).toContain('if (!allowedWhileMustChange(pathname)) {');
    expect(mw).toContain("code: 'password_change_required'");
    expect(mw).toContain("url.pathname = '/my/password';");
    expect(mw).toContain("url.searchParams.set('required', '1');");
    expect(mw).toContain("} else if (verdict !== 'ok') return endUserSession(req, pathname, verdict);");
  });
  it('임시 비밀번호를 주는 세 곳이 표시를 켜고, 본인 바꾸기가 끈다', () => {
    expect(readFileSync('src/app/api/users/route.ts', 'utf8')).toContain('password_must_change: true');
    expect(readFileSync('src/app/api/admin/bulk-register/route.ts', 'utf8')).toContain('password_must_change: true');
    expect(readFileSync('src/lib/password-reset.ts', 'utf8')).toContain('deps.markPasswordChanged(target.id, true)');
    const change = readFileSync('src/lib/password-change.ts', 'utf8');
    expect(change).toContain('deps.markPasswordChanged(userId, false)');
    expect(change).toContain('password_must_change: mustChange');
  });
  it('슈퍼관리자 재발급 — 직원 계정만·비활성 막음·감사 기록(비밀번호 없음)·화면 단추', () => {
    const src = readFileSync('src/app/api/super/accounts/users/[id]/password-reset/route.ts', 'utf8');
    expect(src).toContain('getSuperAdminFromRequest(request)');
    expect(src).toContain(".eq('is_super_admin', false)");
    expect(src).toContain('if (target.is_active === false)');
    expect(src).toContain("action: 'password_reset'");
    expect(src).not.toMatch(/after_data: \{[^}]*tempPassword/);
    expect(readFileSync('src/app/super/accounts/page.tsx', 'utf8')).toContain('/api/super/accounts/users/${id}/password-reset');
  });
  it('비밀번호 바꾸기 화면 — 미들웨어가 보낸 경우 안내, useSearchParams 없이', () => {
    const page = readFileSync('src/app/my/password/page.tsx', 'utf8');
    expect(page).toContain("get('required') === '1'");
    expect(page).not.toMatch(/import[^;]*useSearchParams/);
  });
});

const url = process.env.WORK_TEST_DATABASE_URL;
describe.skipIf(!url)('0093 임시 비밀번호 표시 (시험 DB)', () => {
  let db: pg.Client;
  beforeAll(async () => {
    if (/supabase\.(co|com)|pooler\./.test(url!)) throw new Error('운영 DB 주소로 보입니다 — 시험 DB를 쓰세요');
    db = new pg.Client({ connectionString: url });
    await db.connect();
    const sql = readFileSync('supabase/migrations/0093_password_must_change.sql', 'utf8');
    await db.query(sql);
    await db.query(sql);
  });
  afterAll(async () => { await db?.end(); });
  it('users.password_must_change boolean NOT NULL DEFAULT false', async () => {
    const r = await db.query("SELECT data_type, is_nullable, column_default FROM information_schema.columns WHERE table_name = 'users' AND column_name = 'password_must_change'");
    expect(r.rows[0]).toEqual({ data_type: 'boolean', is_nullable: 'NO', column_default: 'false' });
  });
});
