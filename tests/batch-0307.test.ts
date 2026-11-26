import { readFileSync } from 'fs';
import { createSign, generateKeyPairSync, randomUUID } from 'crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import pg from 'pg';

/**
 * 2026-11-26 — 기관 SSO back-channel 로그아웃이 sid가 오면 **그 세션 하나만** 끝낸다(0121, OIDC Back-Channel Logout 규칙대로).
 * 기관 계정 로그인 때 id_token의 sid를 WORKON 로그인 토큰(`ssoSid`)에 싣고, sid가 온 logout_token이면 직원 행의 끝낸 세션 목록
 * (`{로그아웃 초}:{sid}`, 최근 20개)에 그 하나만 더한다(`sso_end_session`). 미들웨어는 이미 읽는 직원 행에서 목록을 함께 읽어
 * 그 sid의 로그인만 끝낸다. sid를 싣지 않은 로그인(이 배포 전·id_token에 sid가 없던 로그인)은 어느 세션인지 몰라 예전처럼 끝낸다.
 * sub만 온 토큰은 예전처럼 모두 끝낸다.
 */

vi.mock('@/lib/supabaseAdmin', () => ({ supabaseAdmin: {} }));
vi.mock('@/lib/config', () => ({ NEXTAUTH_SECRET: 'test-secret', NEXTAUTH_URL: 'https://workon.test', SUPABASE_DOCUMENTS_BUCKET: 'documents', NODA_API_URL: 'https://noda.test', NODA_API_KEY: '' }));
vi.mock('@/lib/logger', () => ({ logSystem: vi.fn(async () => {}) }));
vi.mock('@/lib/crypto', () => ({ decryptApiKey: (s: string) => s.replace(/^enc:/, ''), encryptApiKey: (s: string) => `enc:${s}`, EncryptionKeyMissingError: class extends Error {} }));

import { BACKCHANNEL_LOGOUT_EVENT, finishSso, handleBackchannelLogout, startSso, type SsoBackchannelIo, type SsoConfigRow, type SsoIo } from '@/lib/org-sso';
import { readUserStatus, sessionEndedBySid, userSessionVerdict, type UserStatus } from '@/lib/middleware-db';

const ISSUER = 'https://idp.example.com/realms/agency';
const CLIENT = 'workon';
const NOW = Date.parse('2026-11-26T03:00:00Z');
const NOW_S = NOW / 1000;
const APP = 'https://workon.test';
const SECRET = 'test-secret';

const rsa = generateKeyPairSync('rsa', { modulusLength: 2048 });
const jwk = { ...(rsa.publicKey.export({ format: 'jwk' }) as Record<string, unknown>), kid: 'k1', use: 'sig', alg: 'RS256' };
const keys = [jwk] as never[];
const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url');
function jwt(claims: Record<string, unknown>): string {
  const head = `${b64({ alg: 'RS256', kid: 'k1', typ: 'logout+jwt' })}.${b64(claims)}`;
  return `${head}.${createSign('RSA-SHA256').update(head).sign(rsa.privateKey).toString('base64url')}`;
}
const logoutClaims = (over: Record<string, unknown> = {}) => ({
  iss: ISSUER, aud: CLIENT, iat: NOW_S - 5, jti: 'j1', sid: 'sess-1', events: { [BACKCHANNEL_LOGOUT_EVENT]: {} }, ...over,
});
const config = (over: Partial<SsoConfigRow> = {}): SsoConfigRow => ({
  organization_id: 'org-1', issuer: ISSUER, client_id: CLIENT, client_secret_encrypted: 'enc:shh', email_domains: [], enabled: true, button_label: null, updated_at: null, ...over,
});
const discovery = { issuer: ISSUER, authorization_endpoint: 'https://idp.example.com/auth', token_endpoint: 'https://idp.example.com/token', jwks_uri: 'https://idp.example.com/keys' };

describe('끝낸 세션 항목 — `{로그아웃 초}:{sid}`', () => {
  const at = NOW_S - 5;
  it('sid가 같고 로그인이 그때나 그 전이면 끝난 것', () => {
    expect(sessionEndedBySid([`${at}:sess-1`], 'sess-1', at - 60)).toBe(true);
    expect(sessionEndedBySid([`${at}:sess-1`], 'sess-1', at)).toBe(true);
    // 계정 서비스가 같은 번호를 다시 써도 로그아웃 뒤에 들어온 로그인은 끝내지 않는다
    expect(sessionEndedBySid([`${at}:sess-1`], 'sess-1', at + 1)).toBe(false);
    // 로그인한 때를 모르면 끝낸다(끝내는 쪽)
    expect(sessionEndedBySid([`${at}:sess-1`], 'sess-1', null)).toBe(true);
  });
  it('다른 sid·빈 목록·깨진 항목은 끝나지 않음, sid 안의 쌍점도 그대로', () => {
    expect(sessionEndedBySid([`${at}:sess-2`], 'sess-1', 1)).toBe(false);
    expect(sessionEndedBySid([], 'sess-1', 1)).toBe(false);
    expect(sessionEndedBySid(undefined, 'sess-1', 1)).toBe(false);
    expect(sessionEndedBySid(['sess-1', ':sess-1', 'x:sess-1', '1.5:sess-1'], 'sess-1', 1)).toBe(false);
    expect(sessionEndedBySid([`${at}:urn:a:b`], 'urn:a:b', 1)).toBe(true);
    expect(sessionEndedBySid([`${at}:urn:a:b`], 'a:b', 1)).toBe(false);
  });
});

describe('미들웨어 — sid가 실린 로그인은 그 sid로만 끝낸다', () => {
  const SUB = '11111111-1111-4111-8111-111111111111';
  const LOGOUT_S = NOW_S - 5;
  const status: UserStatus = { kind: 'active', role: 'USER', departmentId: 'd1', ssoLogoutAt: null, ssoEndedSessions: [`${LOGOUT_S}:sess-1`], ssoSidLogoutAt: LOGOUT_S * 1000 };
  const verdict = (token: Record<string, unknown>, s: UserStatus = status) =>
    userSessionVerdict(new Map(), { sub: SUB, role: 'USER', departmentId: 'd1', ...token }, async () => s, NOW);
  const before = (LOGOUT_S - 60) * 1000;
  it('끝낸 sid의 로그인만 끝나고, 같은 직원의 다른 sid 로그인은 그대로', async () => {
    expect(await verdict({ sso: true, ssoSid: 'sess-1', authAt: before })).toBe('sso_logged_out');
    expect(await verdict({ sso: true, ssoSid: 'sess-2', authAt: before })).toBe('ok');
    expect(await verdict({ sso: true, ssoSid: 'sess-1', authAt: (LOGOUT_S + 2) * 1000 })).toBe('ok');
  });
  it('sid를 싣지 않은 기관 계정 로그인은 sid 로그아웃 시각으로 끝난다(어느 세션인지 몰라서)', async () => {
    expect(await verdict({ sso: true, authAt: before })).toBe('sso_logged_out');
    expect(await verdict({ sso: true, authAt: (LOGOUT_S + 2) * 1000 })).toBe('ok');
    expect(await verdict({ sso: true, ssoSid: '', authAt: before })).toBe('sso_logged_out');
  });
  it('비밀번호 로그인·대리 접근은 그대로, sub로 받은 로그아웃(sso_logout_at)은 sid가 실려도 모두 끝낸다', async () => {
    expect(await verdict({ ssoSid: 'sess-1', authAt: before })).toBe('ok');
    expect(await verdict({ sso: true, ssoSid: 'sess-1', isImpersonating: true, authAt: before })).toBe('ok');
    const all: UserStatus = { kind: 'active', role: 'USER', departmentId: 'd1', ssoLogoutAt: LOGOUT_S * 1000, ssoEndedSessions: [], ssoSidLogoutAt: null };
    expect(await verdict({ sso: true, ssoSid: 'sess-9', authAt: before }, all)).toBe('sso_logged_out');
    expect(await verdict({ sso: true, authAt: before }, { ...all, ssoLogoutAt: null })).toBe('ok');
  });
  it('계정 상태를 읽을 때 두 칸도 읽는다(최근 20개·글만)', async () => {
    const entries = Array.from({ length: 25 }, (_, i) => `${LOGOUT_S}:s${i}`);
    const f = vi.fn(async () => new Response(JSON.stringify([{ role: 'USER', department_id: 'd1', is_active: true, deleted_at: null, sso_ended_sessions: [...entries, 7], sso_sid_logout_at: '2026-11-26T02:59:55Z' }])));
    const got = await readUserStatus({ url: 'https://x.supabase.co', key: 'k' } as never, SUB, f as never);
    expect(got).toMatchObject({ kind: 'active', ssoSidLogoutAt: LOGOUT_S * 1000 });
    expect((got as { ssoEndedSessions: string[] }).ssoEndedSessions).toEqual(entries.slice(-20));
    expect(String((f.mock.calls[0] as unknown[])[0])).toContain(',sso_logout_at,sso_ended_sessions,sso_sid_logout_at');
    const none = vi.fn(async () => new Response(JSON.stringify([{ role: 'USER', department_id: 'd1', is_active: true, deleted_at: null }])));
    expect(await readUserStatus({ url: 'https://x.supabase.co', key: 'k' } as never, SUB, none as never)).toMatchObject({ ssoEndedSessions: [], ssoSidLogoutAt: null });
  });
});

function bcIo(over: Partial<SsoBackchannelIo> = {}) {
  const calls = { subjects: [] as unknown[], sessions: [] as unknown[], marks: [] as unknown[], ends: [] as unknown[] };
  const io: SsoBackchannelIo = {
    configsByIssuer: async () => [config()],
    fetch: (async (input: string) => {
      const url = String(input);
      if (url.endsWith('/.well-known/openid-configuration')) return new Response(JSON.stringify(discovery));
      if (url === 'https://idp.example.com/keys') return new Response(JSON.stringify({ keys }));
      return new Response('nope', { status: 404 });
    }) as unknown as typeof fetch,
    publicHost: async () => true,
    subjectUsers: async (a) => { calls.subjects.push(a); return ['u-sub']; },
    sessionUsers: async (a) => { calls.sessions.push(a); return ['u-sid']; },
    markLoggedOut: async (a) => { calls.marks.push(a); return true; },
    endSession: async (a) => { calls.ends.push(a); return true; },
    now: () => NOW,
    ...over,
  };
  return { io, calls };
}

describe('back-channel 로그아웃 — sid가 오면 그 세션만', () => {
  it('sid만 → sid로 찾은 직원의 그 세션만 끝낸다(모두 끝내기는 안 씀)', async () => {
    const { io, calls } = bcIo();
    expect(await handleBackchannelLogout(jwt(logoutClaims()), io)).toEqual({ status: 200, ended: 1 });
    expect(calls.ends).toEqual([{ userId: 'u-sid', organizationId: 'org-1', sid: 'sess-1', atMs: NOW - 5000 }]);
    expect(calls.marks).toEqual([]);
  });
  it('sub와 sid → sub로 찾고 그 sid의 세션만', async () => {
    const { io, calls } = bcIo();
    expect(await handleBackchannelLogout(jwt(logoutClaims({ sub: 'kc-1' })), io)).toEqual({ status: 200, ended: 1 });
    expect(calls.sessions).toEqual([]);
    expect(calls.ends).toEqual([{ userId: 'u-sub', organizationId: 'org-1', sid: 'sess-1', atMs: NOW - 5000 }]);
    expect(calls.marks).toEqual([]);
  });
  it('sub만 → 예전처럼 모두 끝낸다', async () => {
    const { io, calls } = bcIo();
    expect(await handleBackchannelLogout(jwt(logoutClaims({ sid: undefined, sub: 'kc-1' })), io)).toEqual({ status: 200, ended: 1 });
    expect(calls.ends).toEqual([]);
    expect(calls.marks).toEqual([{ userId: 'u-sub', organizationId: 'org-1', atMs: NOW - 5000 }]);
  });
  it('이미 적힌 항목(같은 토큰이 다시 옴)은 끝낸 수에 안 들고, 못 쓰면 503(계정 서비스가 다시 보낸다)', async () => {
    expect(await handleBackchannelLogout(jwt(logoutClaims()), bcIo({ endSession: async () => false }).io)).toEqual({ status: 200, ended: 0 });
    expect((await handleBackchannelLogout(jwt(logoutClaims()), bcIo({ endSession: async () => { throw new Error('db'); } }).io)).status).toBe(503);
  });
  it('실제 쓰기는 함수 한 번(sso_end_session) — sid는 보안 로그에 남기지 않는다', () => {
    const src = readFileSync('src/lib/org-sso.ts', 'utf8');
    const body = src.slice(src.indexOf('async endSession({ userId, sid, atMs })'), src.indexOf('async endSession({ userId, sid, atMs })') + 900);
    expect(body).toContain(".rpc('sso_end_session', { p_user_id: userId, p_sid: sid, p_at: at })");
    expect(body).toContain("scope: 'session'");
    expect(body).not.toMatch(/logSecurityEvent\([^)]*\bsid\b/);
  });
});

describe('로그인 — sid를 토큰에 싣는다', () => {
  function loginIo(idClaims: Record<string, unknown>) {
    let nonce = '';
    let rand = 0;
    const minted: unknown[] = [];
    const io: SsoIo = {
      loadOrgBySlug: async (slug) => ({ id: 'org-1', slug, status: 'active' }),
      loadConfig: async () => config(),
      decrypt: (s) => s.replace(/^enc:/, ''),
      fetch: (async (input: string, init?: RequestInit) => {
        const url = String(input);
        if (url.endsWith('/.well-known/openid-configuration')) return new Response(JSON.stringify(discovery));
        if (url === 'https://idp.example.com/token' && init?.method === 'POST') {
          return new Response(JSON.stringify({ id_token: jwt({ iss: ISSUER, aud: CLIENT, exp: NOW_S + 600, iat: NOW_S, nonce, sub: 'kc-1', email: 'kim@agency.go.kr', ...idClaims }) }));
        }
        if (url === 'https://idp.example.com/keys') return new Response(JSON.stringify({ keys }));
        return new Response('nope', { status: 404 });
      }) as unknown as typeof fetch,
      publicHost: async () => true,
      findUser: async () => ({ id: 'u1', email: 'kim@agency.go.kr', full_name: '김주무관', role: 'USER', department_id: 'd1', is_active: true, deleted_at: null, is_super_admin: false }),
      lockIfDormant: async () => false,
      record: async () => {},
      mintSession: async (u) => { minted.push(u); return 'SESSION'; },
      now: () => NOW,
      random: (n) => Buffer.alloc(n, ++rand),
    };
    const run = async () => {
      const started = await startSso('agency', io, APP, SECRET);
      const auth = new URL(started.redirect);
      nonce = auth.searchParams.get('nonce')!;
      return finishSso(new URLSearchParams({ code: 'C', state: auth.searchParams.get('state')! }), started.stateCookie, io, APP, SECRET);
    };
    return { run, minted };
  }
  it('id_token의 sid(꼴이 맞을 때만)를 세션 만들기에 넘긴다', async () => {
    const ok = loginIo({ sid: 'sess-9' });
    expect(await ok.run()).toEqual({ redirect: '/', session: 'SESSION' });
    expect(ok.minted).toEqual([expect.objectContaining({ id: 'u1', sid: 'sess-9' })]);
    for (const claims of [{}, { sid: '' }, { sid: 'x'.repeat(256) }, { sid: 3 }]) {
      const bad = loginIo(claims);
      expect(await bad.run()).toEqual({ redirect: '/', session: 'SESSION' });
      expect(bad.minted).toEqual([expect.objectContaining({ id: 'u1', sid: null })]);
    }
  });
  it('토큰에는 sid가 있을 때만 ssoSid — 세션을 다시 써도(jwt 콜백) 남는다', () => {
    const src = readFileSync('src/lib/org-sso.ts', 'utf8');
    expect(src).toContain('...(user.sid ? { ssoSid: user.sid } : {})');
    const auth = readFileSync('src/lib/nextAuthOptions.ts', 'utf8');
    const cb = auth.slice(auth.indexOf('async jwt({ token, user })'), auth.indexOf('async session({'));
    expect(cb).toContain('return token;');
    expect(cb).not.toMatch(/return \{/);
  });
});

const dbUrl = process.env.WORK_TEST_DATABASE_URL;
describe.skipIf(!dbUrl)('0121 — 끝낸 세션 목록(시험 DB)', () => {
  let db: pg.Client;
  beforeAll(async () => {
    if (/supabase\.(co|com)|pooler\./.test(dbUrl!)) throw new Error('운영 DB 주소로 보입니다 — 시험 DB를 쓰세요');
    db = new pg.Client({ connectionString: dbUrl });
    await db.connect();
  });
  afterAll(async () => { await db?.end(); });
  it('여러 번 적용해도 안전·더하기·같은 항목은 안 바꿈·최근 20개·시각은 늦은 쪽·탈퇴 직원은 안 바꿈·권한', async () => {
    await db.query('BEGIN');
    try {
      const sql = readFileSync('supabase/migrations/0121_sso_ended_sessions.sql', 'utf8');
      await db.query(sql); await db.query(sql);
      const org = randomUUID(); const dept = randomUUID(); const user = randomUUID(); const gone = randomUUID();
      await db.query('INSERT INTO organizations (id, name) VALUES ($1, $2)', [org, '0121 기관']);
      await db.query("INSERT INTO departments (id, name, slug, organization_id) VALUES ($1, '총무과', $2, $3)", [dept, `d-${dept.slice(0, 8)}`, org]);
      await db.query("INSERT INTO users (id, email, role, department_id) VALUES ($1, $2, 'USER', $3)", [user, `${user}@x.test`, dept]);
      await db.query("INSERT INTO users (id, email, role, department_id, deleted_at) VALUES ($1, $2, 'USER', $3, now())", [gone, `${gone}@x.test`, dept]);
      const end = (u: string, sid: string, at: string) => db.query('SELECT department_id FROM sso_end_session($1, $2, $3)', [u, sid, at]);
      const read = async () => (await db.query('SELECT sso_ended_sessions, sso_sid_logout_at FROM users WHERE id = $1', [user])).rows[0];
      expect((await read())).toEqual({ sso_ended_sessions: [], sso_sid_logout_at: null });
      expect((await end(user, 'urn:sess:1', '2026-11-26T03:00:00Z')).rows).toEqual([{ department_id: dept }]);
      const sec = Date.parse('2026-11-26T03:00:00Z') / 1000;
      expect((await read()).sso_ended_sessions).toEqual([`${sec}:urn:sess:1`]);
      // 같은 토큰이 다시 오면 줄 없음(안 바꿈)
      expect((await end(user, 'urn:sess:1', '2026-11-26T03:00:00Z')).rows).toEqual([]);
      // 앞선 시각의 다른 sid — 목록에는 더하고 sid 로그아웃 시각은 늦은 쪽 그대로
      await end(user, 'sess-2', '2026-11-26T02:00:00Z');
      expect((await read()).sso_sid_logout_at.toISOString()).toBe('2026-11-26T03:00:00.000Z');
      for (let i = 0; i < 25; i++) await end(user, `s${i}`, '2026-11-26T04:00:00Z');
      const list = (await read()).sso_ended_sessions as string[];
      expect(list).toHaveLength(20);
      expect(list[19]).toBe(`${sec + 3600}:s24`);
      expect(list[0]).toBe(`${sec + 3600}:s5`);
      expect((await end(gone, 'sess-x', '2026-11-26T03:00:00Z')).rows).toEqual([]);
      for (const [u, sid] of [[user, ''], [user, 'x'.repeat(256)]]) {
        await db.query('SAVEPOINT s');
        await expect(end(u, sid, '2026-11-26T03:00:00Z')).rejects.toThrow(/bad input/);
        await db.query('ROLLBACK TO SAVEPOINT s');
      }
      await db.query('SAVEPOINT s');
      await expect(db.query("UPDATE users SET sso_ended_sessions = array_fill('a'::text, ARRAY[21]) WHERE id = $1", [user])).rejects.toThrow(/check/i);
      await db.query('ROLLBACK TO SAVEPOINT s');
      const grants = await db.query("SELECT has_function_privilege('anon', 'public.sso_end_session(uuid, text, timestamptz)', 'EXECUTE') AS anon WHERE EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon')");
      for (const row of grants.rows) expect(row.anon).toBe(false);
    } finally {
      await db.query('ROLLBACK');
    }
  });
});
