import { readFileSync } from 'fs';
import { describe, expect, it, vi } from 'vitest';
import {
  SUPER_STATUS_STALE_MS, SUPER_STATUS_TTL_MS, readUserStatus, sessionCookieNames, userSessionVerdict, type UserStatus,
} from '@/lib/middleware-db';

/** 2026-11-16 — 직원 세션(30일 JWT)을 비활성·탈퇴·권한/소속 변경 뒤에도 만료까지 쓰던 것을 미들웨어가 끊는다 */

const SUB = '11111111-2222-3333-4444-555555555555';
const DEPT = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
const cfg = { url: 'https://x.supabase.co', key: 'k' };
const reply = (body: unknown, ok = true) => vi.fn(async (_url: string, _init?: { headers?: Record<string, string> }) => ({ ok, json: async () => body }));

describe('계정 상태 읽기', () => {
  it('서비스 키로 그 id 한 줄만, 역할은 로그인과 같은 규칙으로', async () => {
    const f = reply([{ role: 'admin', department_id: DEPT, is_active: true, deleted_at: null }]);
    expect(await readUserStatus(cfg, SUB, f)).toEqual({ kind: 'active', role: 'ADMIN', departmentId: DEPT, passwordChangedAt: null, mustChangePassword: false });
    expect(f.mock.calls[0][0]).toBe(`https://x.supabase.co/rest/v1/users?id=eq.${SUB}&select=role,department_id,is_active,deleted_at,password_changed_at,password_must_change`);
    expect(f.mock.calls[0][1]).toEqual({ headers: { apikey: 'k', Authorization: 'Bearer k' } });
    expect(await readUserStatus(cfg, SUB, reply([{ role: null, department_id: DEPT }]))).toMatchObject({ role: 'USER' });
  });
  it('행 없음·비활성·탈퇴는 inactive, id 꼴이 아니면 묻지도 않음', async () => {
    expect(await readUserStatus(cfg, SUB, reply([]))).toEqual({ kind: 'inactive' });
    expect(await readUserStatus(cfg, SUB, reply([{ role: 'USER', is_active: false }]))).toEqual({ kind: 'inactive' });
    expect(await readUserStatus(cfg, SUB, reply([{ role: 'USER', deleted_at: '2026-11-01T00:00:00Z' }]))).toEqual({ kind: 'inactive' });
    const f = reply([]);
    expect(await readUserStatus(cfg, "x' or 1=1", f)).toEqual({ kind: 'inactive' });
    expect(f).not.toHaveBeenCalled();
  });
  it('못 읽으면 error(설정 없음·실패 응답·던짐·꼴이 다름)', async () => {
    expect(await readUserStatus(null, SUB, reply([]))).toEqual({ kind: 'error' });
    expect(await readUserStatus(cfg, SUB, reply([], false))).toEqual({ kind: 'error' });
    expect(await readUserStatus(cfg, SUB, vi.fn(async () => { throw new Error('net'); }))).toEqual({ kind: 'error' });
    expect(await readUserStatus(cfg, SUB, reply({ message: 'x' }))).toEqual({ kind: 'error' });
  });
});

describe('세션 판정', () => {
  const token = { sub: SUB, role: 'USER', departmentId: DEPT };
  const active: UserStatus = { kind: 'active', role: 'USER', departmentId: DEPT };
  it('활성·역할·부서가 같으면 ok, 비활성이면 inactive, 역할·부서가 다르면 changed', async () => {
    expect(await userSessionVerdict(new Map(), token, async () => active)).toBe('ok');
    expect(await userSessionVerdict(new Map(), token, async () => ({ kind: 'inactive' }))).toBe('inactive');
    expect(await userSessionVerdict(new Map(), { ...token, role: 'ADMIN' }, async () => active)).toBe('changed'); // 강등된 관리자의 옛 토큰
    expect(await userSessionVerdict(new Map(), { ...token, departmentId: 'other' }, async () => active)).toBe('changed'); // 부서를 옮김
    expect(await userSessionVerdict(new Map(), { ...token, departmentId: undefined }, async () => active)).toBe('changed');
  });
  it('30초 안에는 다시 읽지 않고, 지나면 다시 읽는다', async () => {
    const cache = new Map();
    const read = vi.fn(async () => active);
    await userSessionVerdict(cache, token, read, 1_000);
    await userSessionVerdict(cache, token, read, 1_000 + SUPER_STATUS_TTL_MS - 1);
    expect(read).toHaveBeenCalledTimes(1);
    await userSessionVerdict(cache, token, read, 1_000 + SUPER_STATUS_TTL_MS);
    expect(read).toHaveBeenCalledTimes(2);
  });
  it('비활성화하면 30초 안에 끊긴다', async () => {
    const cache = new Map();
    let status: UserStatus = active;
    const read = async () => status;
    expect(await userSessionVerdict(cache, token, read, 0)).toBe('ok');
    status = { kind: 'inactive' };
    expect(await userSessionVerdict(cache, token, read, SUPER_STATUS_TTL_MS)).toBe('inactive');
  });
  it('못 읽으면 10분 안의 마지막 값, 그것도 없으면 받는다(열림)', async () => {
    const cache = new Map();
    await userSessionVerdict(cache, token, async () => ({ kind: 'inactive' }), 0);
    expect(await userSessionVerdict(cache, token, async () => ({ kind: 'error' }), SUPER_STATUS_STALE_MS - 1)).toBe('inactive');
    expect(await userSessionVerdict(cache, token, async () => ({ kind: 'error' }), SUPER_STATUS_STALE_MS)).toBe('ok');
    expect(await userSessionVerdict(new Map(), token, async () => ({ kind: 'error' }))).toBe('ok');
  });
  it('지울 쿠키 — 세션 쿠키와 조각만', () => {
    expect(sessionCookieNames([
      'next-auth.session-token', '__Secure-next-auth.session-token.0', '__Secure-next-auth.session-token.1',
      'next-auth.csrf-token', 'super_token', 'next-auth.session-token-x',
    ])).toEqual(['next-auth.session-token', '__Secure-next-auth.session-token.0', '__Secure-next-auth.session-token.1']);
  });
});

describe('연결(원본)', () => {
  const mw = readFileSync('src/middleware.ts', 'utf8');
  it('토큰이 있는 요청마다 IP 판정보다 먼저 계정을 본다', () => {
    const check = mw.indexOf('userSessionVerdict(userStatusCache, ipToken');
    expect(check).toBeGreaterThan(0);
    expect(check).toBeLessThan(mw.indexOf('allowedIpsForDepartment(ipDeptId)'));
    expect(mw).toContain("if (verdict !== 'ok') return endUserSession(req, pathname, verdict);");
  });
  it('대리 접근 토큰은 들어온 슈퍼관리자도 활성이어야 한다', () => {
    expect(mw).toMatch(/if \(ipToken\.isImpersonating\) \{[\s\S]{0,200}superAdminActive\(superStatusCache, by,/);
  });
  it('끝난 세션 — 쿠키를 지우고 API는 401, 로그인 화면은 그대로, 그 밖은 로그인으로', () => {
    expect(mw).toContain('sessionCookieNames(req.cookies.getAll().map((c) => c.name))');
    expect(mw).toContain('{ status: 401 }');
    expect(mw).toContain("url.searchParams.set('error', verdict === 'changed' ? 'session_changed' : verdict === 'password_changed' ? 'password_changed' : 'session_ended');");
    expect(mw).toContain('SIGN_IN_PAGES.test(pathname)');
    const form = readFileSync('src/components/auth/LoginForm.tsx', 'utf8');
    expect(form).toContain("redirectError === 'session_changed'");
    expect(form).toContain("redirectError === 'session_ended'");
  });
  it('대리 접근은 활성 관리자로만, 서명 비밀값은 config에서(고정 값 없음)', () => {
    const src = readFileSync('src/app/api/super/organizations/[id]/impersonate/route.ts', 'utf8');
    expect(src).toContain(".eq('is_active', true)");
    expect(src).toContain(".is('deleted_at', null)");
    expect(src).toContain(".eq('is_super_admin', false)");
    expect(src).not.toContain('fallback-secret');
    expect(src).not.toContain('process.env.NEXTAUTH_SECRET');
    expect(src).toContain("import { NEXTAUTH_SECRET, NEXTAUTH_URL } from '@/lib/config';"); // 0271부터 NEXTAUTH_URL도 config에서
  });
});
