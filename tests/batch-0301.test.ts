import { readFileSync } from 'fs';
import { createSign, generateKeyPairSync, randomUUID } from 'crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import pg from 'pg';

/**
 * 2026-11-25 — 기관 SSO 세션 번호(sid)만 오는 back-channel 로그아웃(0118). OIDC Back-Channel Logout은 sub와 sid 중 하나만 보내도 된다.
 * 로그인 때 id_token의 sid → 직원을 적어 두고, sid만 온 logout_token이면 그 직원의 그 전 기관 계정 로그인을 끝낸다(sub가 왔을 때와 같게).
 * sub가 함께 오면 예전처럼 sub로 찾는다.
 */

vi.mock('@/lib/supabaseAdmin', () => ({ supabaseAdmin: {} }));
vi.mock('@/lib/config', () => ({ NEXTAUTH_SECRET: 'test-secret', NEXTAUTH_URL: 'https://workon.test', SUPABASE_DOCUMENTS_BUCKET: 'documents', NODA_API_URL: 'https://noda.test', NODA_API_KEY: '' }));
vi.mock('@/lib/logger', () => ({ logSystem: vi.fn(async () => {}) }));
vi.mock('@/lib/crypto', () => ({ decryptApiKey: (s: string) => s.replace(/^enc:/, ''), encryptApiKey: (s: string) => `enc:${s}`, EncryptionKeyMissingError: class extends Error {} }));

import {
  BACKCHANNEL_LOGOUT_EVENT, finishSso, handleBackchannelLogout, SSO_SESSION_MAX_AGE_S, SSO_SESSION_ROW_TTL_MS, startSso, verifyLogoutToken,
  type SsoBackchannelIo, type SsoConfigRow, type SsoIo,
} from '@/lib/org-sso';

const ISSUER = 'https://idp.example.com/realms/agency';
const CLIENT = 'workon';
const NOW = Date.parse('2026-11-25T03:00:00Z');
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
  iss: ISSUER, aud: CLIENT, iat: NOW / 1000 - 5, jti: 'j1', sid: 'sess-1', events: { [BACKCHANNEL_LOGOUT_EVENT]: {} }, ...over,
});
const check = (token: string) => verifyLogoutToken(token, { issuer: ISSUER, clientId: CLIENT, keys, nowMs: NOW });
const config = (over: Partial<SsoConfigRow> = {}): SsoConfigRow => ({
  organization_id: 'org-1', issuer: ISSUER, client_id: CLIENT, client_secret_encrypted: 'enc:shh', email_domains: [], enabled: true, button_label: null, updated_at: null, ...over,
});
const discovery = { issuer: ISSUER, authorization_endpoint: 'https://idp.example.com/auth', token_endpoint: 'https://idp.example.com/token', jwks_uri: 'https://idp.example.com/keys' };

describe('logout_token — sid만 와도 받는다', () => {
  it('sid만 → sid, sub만 → sub, 둘 다 → 둘 다', () => {
    expect(check(jwt(logoutClaims()))).toEqual({ ok: true, subject: null, sid: 'sess-1', loggedOutAtMs: NOW - 5000 });
    expect(check(jwt(logoutClaims({ sid: undefined, sub: 'kc-1' })))).toEqual({ ok: true, subject: 'kc-1', sid: null, loggedOutAtMs: NOW - 5000 });
    expect(check(jwt(logoutClaims({ sub: 'kc-1' })))).toMatchObject({ ok: true, subject: 'kc-1', sid: 'sess-1' });
  });
  it('둘 다 없거나, 있는데 꼴이 틀리면(빈 글·255자 넘음·글 아님) 거절', () => {
    expect(check(jwt(logoutClaims({ sid: undefined })))).toEqual({ ok: false, reason: 'no_sub_sid' });
    for (const bad of [{ sid: '' }, { sid: 'x'.repeat(256) }, { sid: 7 }, { sub: '', sid: 'sess-1' }, { sub: ['a'] }]) {
      expect(check(jwt(logoutClaims(bad)))).toEqual({ ok: false, reason: 'bad_sub_sid' });
    }
    // 다른 검사는 그대로(nonce가 있으면 id_token 돌려쓰기)
    expect(check(jwt(logoutClaims({ nonce: 'n' })))).toEqual({ ok: false, reason: 'nonce' });
  });
});

function bcIo(over: Partial<SsoBackchannelIo> = {}) {
  const calls = { subjects: [] as unknown[], sessions: [] as unknown[], marks: [] as unknown[] };
  const io: SsoBackchannelIo = {
    configsByIssuer: async () => [config(), config({ organization_id: 'org-2', client_id: 'other-client' })],
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
    now: () => NOW,
    ...over,
  };
  return { io, calls };
}

describe('back-channel 로그아웃 — sid로 직원 찾기', () => {
  it('sid만 온 토큰 — 그 클라이언트 기관에서 sid로 찾은 직원의 로그아웃 시각을 적는다', async () => {
    const { io, calls } = bcIo();
    expect(await handleBackchannelLogout(jwt(logoutClaims()), io)).toEqual({ status: 200, ended: 1 });
    expect(calls.sessions).toEqual([{ organizationId: 'org-1', issuer: ISSUER, sid: 'sess-1' }]);
    expect(calls.subjects).toEqual([]);
    expect(calls.marks).toEqual([{ userId: 'u-sid', organizationId: 'org-1', atMs: NOW - 5000 }]);
  });
  it('sub가 함께 오면 sub로 찾는다(예전 그대로)', async () => {
    const { io, calls } = bcIo();
    expect(await handleBackchannelLogout(jwt(logoutClaims({ sub: 'kc-1' })), io)).toEqual({ status: 200, ended: 1 });
    expect(calls.sessions).toEqual([]);
    expect(calls.marks).toEqual([{ userId: 'u-sub', organizationId: 'org-1', atMs: NOW - 5000 }]);
  });
  it('적어 둔 sid가 없으면 200·아무도 안 끝냄, 읽기 실패는 503(계정 서비스가 다시 보낸다)', async () => {
    expect(await handleBackchannelLogout(jwt(logoutClaims()), bcIo({ sessionUsers: async () => [] }).io)).toEqual({ status: 200, ended: 0 });
    expect(await handleBackchannelLogout(jwt(logoutClaims()), bcIo({ sessionUsers: undefined }).io)).toEqual({ status: 200, ended: 0 });
    expect((await handleBackchannelLogout(jwt(logoutClaims()), bcIo({ sessionUsers: async () => { throw new Error('db'); } }).io)).status).toBe(503);
  });
});

describe('로그인할 때 sid 적어 두기', () => {
  function loginIo(idClaims: Record<string, unknown>, over: Partial<SsoIo> = {}) {
    let nonce = '';
    let rand = 0;
    const sessions: unknown[] = [];
    const io: SsoIo = {
      loadOrgBySlug: async (slug) => ({ id: 'org-1', slug, status: 'active' }),
      loadConfig: async () => config(),
      decrypt: (s) => s.replace(/^enc:/, ''),
      fetch: (async (input: string, init?: RequestInit) => {
        const url = String(input);
        if (url.endsWith('/.well-known/openid-configuration')) return new Response(JSON.stringify(discovery));
        if (url === 'https://idp.example.com/token' && init?.method === 'POST') {
          return new Response(JSON.stringify({ id_token: jwt({ iss: ISSUER, aud: CLIENT, exp: NOW / 1000 + 600, iat: NOW / 1000, nonce, sub: 'kc-1', email: 'kim@agency.go.kr', ...idClaims }) }));
        }
        if (url === 'https://idp.example.com/keys') return new Response(JSON.stringify({ keys }));
        return new Response('nope', { status: 404 });
      }) as unknown as typeof fetch,
      publicHost: async () => true,
      findUser: async () => ({ id: 'u1', email: 'kim@agency.go.kr', full_name: '김주무관', role: 'USER', department_id: 'd1', is_active: true, deleted_at: null, is_super_admin: false }),
      lockIfDormant: async () => false,
      record: async () => {},
      mintSession: async () => 'SESSION',
      now: () => NOW,
      random: (n) => Buffer.alloc(n, ++rand),
      rememberSubject: async () => {},
      rememberSession: async (a) => { sessions.push(a); },
      ...over,
    };
    const run = async () => {
      const started = await startSso('agency', io, APP, SECRET);
      const auth = new URL(started.redirect);
      nonce = auth.searchParams.get('nonce')!;
      return finishSso(new URLSearchParams({ code: 'C', state: auth.searchParams.get('state')! }), started.stateCookie, io, APP, SECRET);
    };
    return { run, sessions };
  }
  it('id_token에 sid가 있으면 기관·발급자·sid → 직원을 적는다', async () => {
    const { run, sessions } = loginIo({ sid: 'sess-9' });
    expect(await run()).toEqual({ redirect: '/', session: 'SESSION' });
    expect(sessions).toEqual([{ organizationId: 'org-1', issuer: ISSUER, sid: 'sess-9', userId: 'u1' }]);
  });
  it('sid가 없거나 꼴이 틀리면 적지 않고, 못 적어도 로그인은 그대로', async () => {
    for (const claims of [{}, { sid: '' }, { sid: 'x'.repeat(256) }, { sid: 3 }]) {
      const { run, sessions } = loginIo(claims);
      expect(await run()).toEqual({ redirect: '/', session: 'SESSION' });
      expect(sessions).toEqual([]);
    }
    const failing = loginIo({ sid: 'sess-9' }, { rememberSession: async () => { throw new Error('db'); } });
    expect(await failing.run()).toEqual({ redirect: '/', session: 'SESSION' });
  });
  it('세션 번호 줄은 WORKON 기관 계정 로그인(30일)보다 하루 더 남긴다', () => {
    expect(SSO_SESSION_ROW_TTL_MS).toBe(SSO_SESSION_MAX_AGE_S * 1000 + 24 * 60 * 60 * 1000);
    const src = readFileSync('src/lib/org-sso.ts', 'utf8');
    expect(src).toContain(".from('org_sso_sessions').upsert(");
    expect(src).toContain(".eq('user_id', userId).lt('created_at', new Date(Date.now() - SSO_SESSION_ROW_TTL_MS).toISOString())");
  });
});

const dbUrl = process.env.WORK_TEST_DATABASE_URL;
describe.skipIf(!dbUrl)('0118 — sid 표(시험 DB)', () => {
  let db: pg.Client;
  beforeAll(async () => {
    if (/supabase\.(co|com)|pooler\./.test(dbUrl!)) throw new Error('운영 DB 주소로 보입니다 — 시험 DB를 쓰세요');
    db = new pg.Client({ connectionString: dbUrl });
    await db.connect();
  });
  afterAll(async () => { await db?.end(); });
  it('여러 번 적용해도 안전·기관·발급자·sid 하나·꼴 CHECK·직원을 지우면 함께·RLS', async () => {
    await db.query('BEGIN');
    try {
      const sql = readFileSync('supabase/migrations/0118_org_sso_sessions.sql', 'utf8');
      await db.query(sql); await db.query(sql);
      const org = randomUUID(); const dept = randomUUID(); const user = randomUUID();
      await db.query('INSERT INTO organizations (id, name) VALUES ($1, $2)', [org, '0118 기관']);
      await db.query("INSERT INTO departments (id, name, slug, organization_id) VALUES ($1, '총무과', $2, $3)", [dept, `d-${dept.slice(0, 8)}`, org]);
      await db.query("INSERT INTO users (id, email, role, department_id) VALUES ($1, $2, 'USER', $3)", [user, `${user}@x.test`, dept]);
      const put = (sid: string) => db.query('INSERT INTO org_sso_sessions (organization_id, issuer, sid, user_id) VALUES ($1, $2, $3, $4)', [org, ISSUER, sid, user]);
      await put('sess-1');
      for (const [bad, re] of [['sess-1', /duplicate|unique/i], ['', /check/i], ['x'.repeat(256), /check/i]] as [string, RegExp][]) {
        await db.query('SAVEPOINT s');
        await expect(put(bad)).rejects.toThrow(re);
        await db.query('ROLLBACK TO SAVEPOINT s');
      }
      await db.query('DELETE FROM users WHERE id = $1', [user]);
      expect((await db.query('SELECT count(*)::int n FROM org_sso_sessions WHERE organization_id = $1', [org])).rows[0].n).toBe(0);
      const rls = await db.query("SELECT relrowsecurity FROM pg_class WHERE relname = 'org_sso_sessions'");
      expect(rls.rows).toEqual([{ relrowsecurity: true }]);
    } finally {
      await db.query('ROLLBACK');
    }
  });
});
