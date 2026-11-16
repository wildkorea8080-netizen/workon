import { readFileSync } from 'fs';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/supabaseAdmin', () => ({ supabaseAdmin: {} }));
vi.mock('@/lib/supabase', () => ({ supabase: {} }));

import {
  RESET_PER_IP, RESET_PER_USER, confirmPasswordReset, newResetToken, requestPasswordReset, resetLink, tokenHash,
  type ResetDeps, type ResetUser,
} from '@/lib/password-reset-mail';
import { RESET_LINK_MINUTES, RESET_TOKEN_PATTERN, tokenFromHash } from '@/lib/password-reset-spec';
import { allowedWhileMustChange } from '@/lib/middleware-db';

/** 2026-11-16 — 직원 비밀번호 찾기(메일 재설정 링크, 0096). 예전엔 관리자 재발급뿐이었다 */

const NOW = new Date('2026-11-16T10:00:00Z');
const TOKEN = 'A'.repeat(43);
const USER: ResetUser = { id: 'u1', email: 'kim@x.go.kr', full_name: '김주무관', department_id: 'd1', password_hash: null, is_active: true, deleted_at: null, is_super_admin: false };

type Row = { id: string; user_id: string | null; token_hash: string | null; ip_hash: string | null; expires_at: string | null; used_at: string | null };

function deps(o: { user?: ResetUser | null | 'error'; mail?: boolean; ipCount?: number; userCount?: number; sendOk?: boolean; auth?: 'ok' | 'not_found' | 'error'; claim?: boolean; rows?: Row[] } = {}) {
  const rows: Row[] = o.rows ?? [];
  const sent: string[] = [];
  const calls: string[] = [];
  const d: ResetDeps = {
    mailConfigured: () => o.mail !== false,
    findUserByEmail: vi.fn(async () => (o.user === undefined ? USER : o.user)),
    readUser: vi.fn(async () => (o.user === undefined ? USER : o.user)),
    countRequests: vi.fn(async (field) => (field === 'ip_hash' ? o.ipCount ?? 0 : o.userCount ?? 0)),
    insertRequest: vi.fn(async (r) => { const id = `r${rows.length + 1}`; rows.push({ id, used_at: null, ...r }); return id; }),
    expireOpen: vi.fn(async (uid, at, except) => { calls.push(`expire:${uid}:${except ?? '-'}`); }),
    findToken: vi.fn(async (h) => rows.find((r) => r.token_hash === h) ?? null),
    claimToken: vi.fn(async (id) => { calls.push(`claim:${id}`); return o.claim !== false; }),
    releaseToken: vi.fn(async (id) => { calls.push(`release:${id}`); }),
    unlock: vi.fn(async (e) => { calls.push(`unlock:${e}`); }),
    sendLink: vi.fn(async (to, _n, link) => { sent.push(`${to} ${link}`); return o.sendOk !== false; }),
    newToken: () => TOKEN,
    log: vi.fn(async () => {}),
    updateAuthPassword: vi.fn(async () => { calls.push('auth'); return o.auth ?? 'ok'; }),
    hash: vi.fn(async (p) => `h(${p})`),
    setPasswordHash: vi.fn(async () => { calls.push('hash'); return true; }),
    markPasswordChanged: vi.fn(async (_id, must) => { calls.push(`mark:${must}`); return true; }),
  };
  return { d, rows, sent, calls };
}

describe('요청 — 계정이 있든 없든 같은 응답', () => {
  it('쓸 수 있는 계정이면 30분 링크를 보내고 열쇠는 해시만 저장, 앞 링크는 끝냄', async () => {
    const { d, rows, sent, calls } = deps();
    expect(await requestPasswordReset(d, { email: ' kim@x.go.kr ', ip: '1.2.3.4' }, NOW)).toEqual({ ok: true });
    expect(rows).toHaveLength(1);
    expect(rows[0].token_hash).toBe(tokenHash(TOKEN));
    expect(JSON.stringify(rows)).not.toContain(TOKEN);
    expect(rows[0].expires_at).toBe(new Date(NOW.getTime() + RESET_LINK_MINUTES * 60_000).toISOString());
    expect(rows[0].ip_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(sent[0]).toMatch(/^kim@x\.go\.kr .*\/reset-password#token=A{43}$/);
    expect(calls).toContain('expire:u1:r1');
  });
  it('없는 계정·사용 중지·탈퇴·슈퍼관리자·꼴이 아닌 주소 — 같은 성공 응답, 메일 없음, 세기용 한 줄만', async () => {
    for (const user of [null, { ...USER, is_active: false }, { ...USER, deleted_at: '2026-01-01' }, { ...USER, is_super_admin: true }]) {
      const { d, rows, sent } = deps({ user });
      expect(await requestPasswordReset(d, { email: 'kim@x.go.kr', ip: '1.2.3.4' }, NOW)).toEqual({ ok: true });
      expect(sent).toEqual([]);
      expect(rows).toEqual([expect.objectContaining({ user_id: null, token_hash: null, expires_at: null })]);
    }
    const { d, rows } = deps();
    expect(await requestPasswordReset(d, { email: 'nope', ip: null }, NOW)).toEqual({ ok: true });
    expect(d.findUserByEmail).not.toHaveBeenCalled();
    expect(rows[0].user_id).toBeNull();
  });
  it('계정마다 1시간 3번 — 넘으면 조용히 같은 응답(메일 없음)', async () => {
    expect(RESET_PER_USER).toBe(3);
    const { d, sent } = deps({ userCount: 3 });
    expect(await requestPasswordReset(d, { email: 'kim@x.go.kr', ip: null }, NOW)).toEqual({ ok: true });
    expect(sent).toEqual([]);
  });
  it('IP마다 1시간 10번 — 넘으면 429(계정과 상관없음), 메일 미설정은 503', async () => {
    expect(RESET_PER_IP).toBe(10);
    expect(await requestPasswordReset(deps({ ipCount: 10 }).d, { email: 'kim@x.go.kr', ip: '1.2.3.4' }, NOW)).toEqual({ ok: false, code: 'ip_limited' });
    expect(await requestPasswordReset(deps({ mail: false }).d, { email: 'kim@x.go.kr', ip: null }, NOW)).toEqual({ ok: false, code: 'mail_off' });
  });
  it('메일을 못 보내도 같은 응답(운영 기록에만, 주소 없이), 계정 조회 실패는 오류', async () => {
    const { d } = deps({ sendOk: false });
    expect(await requestPasswordReset(d, { email: 'kim@x.go.kr', ip: null }, NOW)).toEqual({ ok: true });
    expect(d.log).toHaveBeenCalledWith(expect.any(String), { user_id: 'u1' });
    expect(await requestPasswordReset(deps({ user: 'error' }).d, { email: 'kim@x.go.kr', ip: null }, NOW)).toEqual({ ok: false, code: 'error' });
  });
});

describe('새 비밀번호 정하기', () => {
  const live = (o: Partial<Row> = {}): Row[] => [{ id: 'r1', user_id: 'u1', token_hash: tokenHash(TOKEN), ip_hash: null, expires_at: '2026-11-16T10:20:00Z', used_at: null, ...o }];
  it('살아 있는 열쇠면 차지 → Auth 바꾸기 → 바꾼 때(임시 표시 지움) → 다른 링크 끝 → 잠금 풂', async () => {
    const { d, calls } = deps({ rows: live() });
    expect(await confirmPasswordReset(d, { token: TOKEN, next: 'Newpass123!' }, NOW)).toEqual({ ok: true, userId: 'u1', departmentId: 'd1', sessionsKept: false });
    expect(calls).toEqual(['claim:r1', 'auth', 'mark:false', 'expire:u1:-', 'unlock:kim@x.go.kr']);
  });
  it('password_hash가 있거나 Auth 계정이 없으면 해시도 바꾼다(옛 비밀번호가 두 번째 길로 통과하지 않게)', async () => {
    const a = deps({ rows: live(), user: { ...USER, password_hash: 'old' } });
    await confirmPasswordReset(a.d, { token: TOKEN, next: 'Newpass123!' }, NOW);
    expect(a.calls).toContain('hash');
    const b = deps({ rows: live(), auth: 'not_found' });
    await confirmPasswordReset(b.d, { token: TOKEN, next: 'Newpass123!' }, NOW);
    expect(b.calls).toContain('hash');
  });
  it('꼴이 아닌·없는·쓴·지난 열쇠, 사용 중지 계정, 차지 실패는 모두 같은 안내', async () => {
    const cases: Array<[ReturnType<typeof deps>, string]> = [
      [deps({ rows: live() }), 'short'],
      [deps({ rows: [] }), TOKEN],
      [deps({ rows: live({ used_at: '2026-11-16T09:00:00Z' }) }), TOKEN],
      [deps({ rows: live({ expires_at: '2026-11-16T10:00:00Z' }) }), TOKEN],
      [deps({ rows: live(), user: { ...USER, is_active: false } }), TOKEN],
      [deps({ rows: live(), user: { ...USER, is_super_admin: true } }), TOKEN],
      [deps({ rows: live(), claim: false }), TOKEN],
    ];
    for (const [x, token] of cases) {
      const r = await confirmPasswordReset(x.d, { token, next: 'Newpass123!' }, NOW);
      expect(r).toMatchObject({ ok: false, code: 'invalid' });
      expect(x.calls).not.toContain('auth');
    }
  });
  it('비밀번호 규칙은 열쇠를 쓰기 전에 본다(틀려도 같은 링크로 다시)', async () => {
    const { d, calls } = deps({ rows: live() });
    expect(await confirmPasswordReset(d, { token: TOKEN, next: 'short' }, NOW)).toMatchObject({ ok: false, code: 'policy' });
    expect(calls).toEqual([]);
  });
  it('바꾸다 실패하면 열쇠를 돌려놓는다', async () => {
    const { d, calls } = deps({ rows: live(), auth: 'error' });
    expect(await confirmPasswordReset(d, { token: TOKEN, next: 'Newpass123!' }, NOW)).toEqual({ ok: false, code: 'error' });
    expect(calls).toEqual(['claim:r1', 'auth', 'release:r1']);
  });
});

describe('열쇠·주소', () => {
  it('32바이트 base64url 43자, 해시는 원문과 다름, 링크는 조각(#)에', () => {
    const t = newResetToken();
    expect(t).toMatch(RESET_TOKEN_PATTERN);
    expect(newResetToken()).not.toBe(t);
    expect(tokenHash(t)).toMatch(/^[0-9a-f]{64}$/);
    expect(resetLink('X'.repeat(43), 'https://a.b/')).toBe(`https://a.b/reset-password#token=${'X'.repeat(43)}`);
  });
  it('화면이 주소 조각에서 열쇠를 꺼낸다(꼴이 아니면 null)', () => {
    expect(tokenFromHash(`#token=${TOKEN}`)).toBe(TOKEN);
    expect(tokenFromHash(`#a=1&token=${TOKEN}`)).toBe(TOKEN);
    expect(tokenFromHash('#token=abc')).toBeNull();
    expect(tokenFromHash('')).toBeNull();
    expect(readFileSync('src/lib/password-reset-spec.ts', 'utf8')).not.toMatch(/^import /m);
  });
});

describe('연결(원본)', () => {
  it('공개 라우트 둘·같은 응답 문구·보안 로그', () => {
    const req = readFileSync('src/app/api/password-reset/route.ts', 'utf8');
    expect(req).toContain('RESET_REQUESTED_MESSAGE');
    expect(req).toContain('status: 429');
    expect(req).toContain('status: 503');
    const conf = readFileSync('src/app/api/password-reset/confirm/route.ts', 'utf8');
    expect(conf).toContain("event_type: 'password_reset_by_email'");
    expect(readFileSync('src/app/api/admin/audit-logs/route.ts', 'utf8')).toContain("password_reset_by_email: '비밀번호 재설정(메일 링크)'");
  });
  it('로그인 화면 링크·재설정 화면은 열쇠를 주소에서 지운다·임시 비밀번호로 묶인 동안에도 열림', () => {
    expect(readFileSync('src/components/auth/LoginForm.tsx', 'utf8')).toContain('href="/forgot-password"');
    const page = readFileSync('src/app/reset-password/page.tsx', 'utf8');
    expect(page).toContain('window.history.replaceState(null, \'\', window.location.pathname)');
    // 효과가 두 번 돌면 두 번째가 지운 주소를 읽는다 — 처음 읽은 열쇠를 지킨다
    expect(page).toContain('setToken((prev) => prev ?? read)');
    expect(allowedWhileMustChange('/forgot-password')).toBe(true);
    expect(allowedWhileMustChange('/api/password-reset/confirm')).toBe(true);
    expect(allowedWhileMustChange('/api/password-resetx')).toBe(false);
  });
});

const url = process.env.WORK_TEST_DATABASE_URL;
describe.skipIf(!url)('0096 비밀번호 찾기 표 (시험 DB)', () => {
  let db: pg.Client;
  beforeAll(async () => {
    if (/supabase\.(co|com)|pooler\./.test(url!)) throw new Error('운영 DB 주소로 보입니다 — 시험 DB를 쓰세요');
    db = new pg.Client({ connectionString: url });
    await db.connect();
    const sql = readFileSync('supabase/migrations/0096_password_reset_requests.sql', 'utf8');
    await db.query(sql);
    await db.query(sql);
  });
  afterAll(async () => { await db?.end(); });
  it('RLS 켜짐·꼴 CHECK — 세기용 줄은 열쇠 없음, 계정 줄은 열쇠·기한 필수, 해시 꼴', async () => {
    const rls = await db.query(`SELECT relrowsecurity FROM pg_class WHERE oid='public.password_reset_requests'::regclass`);
    expect(rls.rows[0].relrowsecurity).toBe(true);
    await db.query('BEGIN');
    try {
      await db.query(`INSERT INTO password_reset_requests (user_id, token_hash, ip_hash) VALUES (NULL, NULL, NULL)`);
      await db.query('SAVEPOINT s');
      await expect(db.query(`INSERT INTO password_reset_requests (user_id, token_hash) VALUES (NULL, '${'a'.repeat(64)}')`)).rejects.toMatchObject({ code: '23514' });
      await db.query('ROLLBACK TO SAVEPOINT s');
      await expect(db.query(`INSERT INTO password_reset_requests (ip_hash) VALUES ('nothex')`)).rejects.toMatchObject({ code: '23514' });
    } finally { await db.query('ROLLBACK'); }
  });
});
