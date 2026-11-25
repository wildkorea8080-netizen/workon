import { readFileSync, existsSync } from 'fs';
import { createSign, generateKeyPairSync, randomUUID } from 'crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import pg from 'pg';

/**
 * 2026-11-25 — 기관 SSO back-channel 로그아웃(0114). 계정 서비스가 먼저 로그아웃하면 서명한 logout_token을 보내고, WORKON은 그 sub로
 * 기관 계정 로그인한 직원의 로그아웃 시각을 적어 미들웨어가 그 전 기관 계정 로그인을 끝낸다. sub → 직원은 로그인할 때 적어 둔다.
 */

vi.mock('@/lib/supabaseAdmin', () => ({ supabaseAdmin: {} }));
vi.mock('@/lib/config', () => ({ NEXTAUTH_SECRET: 'test-secret', NEXTAUTH_URL: 'https://workon.test', SUPABASE_DOCUMENTS_BUCKET: 'documents', NODA_API_URL: 'https://noda.test', NODA_API_KEY: '' }));
vi.mock('@/lib/logger', () => ({ logSystem: vi.fn(async () => {}) }));
vi.mock('@/lib/crypto', () => ({ decryptApiKey: (s: string) => s.replace(/^enc:/, ''), encryptApiKey: (s: string) => `enc:${s}`, EncryptionKeyMissingError: class extends Error {} }));

import {
  BACKCHANNEL_LOGOUT_EVENT, finishSso, handleBackchannelLogout, LOGOUT_TOKEN_MAX_LENGTH, ssoErrorMessage, startSso, verifyLogoutToken,
  type SsoBackchannelIo, type SsoConfigRow, type SsoIo,
} from '@/lib/org-sso';
import { readUserStatus, userSessionVerdict, type UserStatus } from '@/lib/middleware-db';
import { API_ROUTES } from '@/lib/api-route-ids';
import { SECURITY_EVENT_LABELS } from '@/lib/security-event-text';

const ISSUER = 'https://idp.example.com/realms/agency';
const CLIENT = 'workon';
const NOW = Date.parse('2026-11-25T03:00:00Z');
const APP = 'https://workon.test';
const SECRET = 'test-secret';

const rsa = generateKeyPairSync('rsa', { modulusLength: 2048 });
const jwk = { ...(rsa.publicKey.export({ format: 'jwk' }) as Record<string, unknown>), kid: 'k1', use: 'sig', alg: 'RS256' };
const other = generateKeyPairSync('rsa', { modulusLength: 2048 });
const keys = [jwk] as never[];

const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url');
function jwt(claims: Record<string, unknown>, key = rsa.privateKey): string {
  const head = `${b64({ alg: 'RS256', kid: 'k1', typ: 'logout+jwt' })}.${b64(claims)}`;
  return `${head}.${createSign('RSA-SHA256').update(head).sign(key).toString('base64url')}`;
}
const logoutClaims = (over: Record<string, unknown> = {}) => ({
  iss: ISSUER, aud: CLIENT, iat: NOW / 1000 - 5, jti: 'j1', sub: 'kc-user-1', sid: 'sess-1', events: { [BACKCHANNEL_LOGOUT_EVENT]: {} }, ...over,
});
const check = (token: string) => verifyLogoutToken(token, { issuer: ISSUER, clientId: CLIENT, keys, nowMs: NOW });

describe('logout_token 검증', () => {
  it('맞으면 sub와 로그아웃 시각(iat)', () => {
    expect(check(jwt(logoutClaims()))).toEqual({ ok: true, subject: 'kc-user-1', sid: 'sess-1', loggedOutAtMs: NOW - 5000 });
    // 시계가 조금 앞선 계정 서비스 — 로그아웃 시각은 지금보다 늦지 않게
    expect(check(jwt(logoutClaims({ iat: NOW / 1000 + 60 })))).toMatchObject({ ok: true, loggedOutAtMs: NOW });
    expect(check(jwt(logoutClaims({ aud: ['x', CLIENT] })))).toMatchObject({ ok: true });
  });
  it('다른 키·발급자·대상·이벤트 없음·nonce 있음·sub 없음·10분 넘은 토큰·미래·만료는 거절', () => {
    expect(check(jwt(logoutClaims(), other.privateKey))).toEqual({ ok: false, reason: 'signature' });
    expect(check(jwt(logoutClaims({ iss: 'https://evil.example.com' })))).toEqual({ ok: false, reason: 'iss' });
    expect(check(jwt(logoutClaims({ aud: 'someone-else' })))).toEqual({ ok: false, reason: 'aud' });
    expect(check(jwt(logoutClaims({ events: {} })))).toEqual({ ok: false, reason: 'events' });
    expect(check(jwt(logoutClaims({ events: { [BACKCHANNEL_LOGOUT_EVENT]: 'yes' } })))).toEqual({ ok: false, reason: 'events' });
    // id_token을 logout_token으로 돌려쓰지 못하게 — nonce가 있으면 거절
    expect(check(jwt(logoutClaims({ nonce: 'n' })))).toEqual({ ok: false, reason: 'nonce' });
    // sub도 sid도 없으면 거절(0118부터 sid만 온 토큰은 받는다 — tests/batch-0301.test.ts)
    expect(check(jwt(logoutClaims({ sub: undefined, sid: undefined })))).toEqual({ ok: false, reason: 'no_sub_sid' });
    expect(check(jwt(logoutClaims({ iat: NOW / 1000 - 11 * 60 })))).toEqual({ ok: false, reason: 'stale' });
    expect(check(jwt(logoutClaims({ iat: NOW / 1000 + 600 })))).toEqual({ ok: false, reason: 'iat' });
    expect(check(jwt(logoutClaims({ iat: undefined })))).toEqual({ ok: false, reason: 'iat' });
    expect(check(jwt(logoutClaims({ exp: NOW / 1000 - 600 })))).toEqual({ ok: false, reason: 'exp' });
    expect(check('a.b')).toMatchObject({ ok: false });
  });
});

function config(over: Partial<SsoConfigRow> = {}): SsoConfigRow {
  return { organization_id: 'org-1', issuer: ISSUER, client_id: CLIENT, client_secret_encrypted: 'enc:shh', email_domains: [], enabled: true, button_label: null, updated_at: null, ...over };
}

function bcIo(over: Partial<SsoBackchannelIo> = {}) {
  const calls = { configs: [] as string[], fetch: [] as string[], subjects: [] as unknown[], marks: [] as unknown[] };
  const io: SsoBackchannelIo = {
    configsByIssuer: async (issuer) => { calls.configs.push(issuer); return [config(), config({ organization_id: 'org-2', client_id: 'other-client' })]; },
    fetch: (async (input: string) => {
      const url = String(input);
      calls.fetch.push(url);
      if (url.endsWith('/.well-known/openid-configuration')) {
        return new Response(JSON.stringify({ issuer: ISSUER, authorization_endpoint: 'https://idp.example.com/auth', token_endpoint: 'https://idp.example.com/token', jwks_uri: 'https://idp.example.com/keys' }));
      }
      if (url === 'https://idp.example.com/keys') return new Response(JSON.stringify({ keys }));
      return new Response('nope', { status: 404 });
    }) as unknown as typeof fetch,
    publicHost: async () => true,
    subjectUsers: async (a) => { calls.subjects.push(a); return ['u1']; },
    markLoggedOut: async (a) => { calls.marks.push(a); return true; },
    now: () => NOW,
    ...over,
  };
  return { io, calls };
}

describe('back-channel 로그아웃 받기', () => {
  it('맞는 토큰 — 그 클라이언트의 기관에서만 sub로 직원을 찾아 로그아웃 시각을 적는다', async () => {
    const { io, calls } = bcIo();
    expect(await handleBackchannelLogout(jwt(logoutClaims()), io)).toEqual({ status: 200, ended: 1 });
    expect(calls.configs).toEqual([ISSUER]);
    expect(calls.subjects).toEqual([{ organizationId: 'org-1', issuer: ISSUER, subject: 'kc-user-1' }]);
    expect(calls.marks).toEqual([{ userId: 'u1', organizationId: 'org-1', atMs: NOW - 5000 }]);
  });
  it('이미 더 늦은 로그아웃이 적혀 있거나(다시 온 옛 토큰) 적어 둔 직원이 없으면 200·끝낸 수 0', async () => {
    expect(await handleBackchannelLogout(jwt(logoutClaims()), bcIo({ markLoggedOut: async () => false }).io)).toEqual({ status: 200, ended: 0 });
    expect(await handleBackchannelLogout(jwt(logoutClaims()), bcIo({ subjectUsers: async () => [] }).io)).toEqual({ status: 200, ended: 0 });
  });
  it('토큰이 없거나 꼴이 틀리거나 너무 길면 아무것도 읽지 않고 400', async () => {
    for (const raw of [null, '', 'abc', 'a.b.c', `${b64({ alg: 'RS256' })}.${b64(['x'])}.sig`, 'x'.repeat(LOGOUT_TOKEN_MAX_LENGTH + 1)]) {
      const { io, calls } = bcIo();
      expect(await handleBackchannelLogout(raw, io)).toEqual({ status: 400, ended: 0 });
      expect(calls.configs).toEqual([]);
    }
  });
  it('모르는 발급자·클라이언트는 공개키를 받으러 가지 않고 400, 서명이 틀리면 직원을 찾지 않고 400', async () => {
    const none = bcIo({ configsByIssuer: async () => [] });
    expect(await handleBackchannelLogout(jwt(logoutClaims()), none.io)).toEqual({ status: 400, ended: 0 });
    const aud = bcIo();
    expect(await handleBackchannelLogout(jwt(logoutClaims({ aud: 'nobody' })), aud.io)).toEqual({ status: 400, ended: 0 });
    expect(aud.calls.fetch).toEqual([]);
    const forged = bcIo();
    expect(await handleBackchannelLogout(jwt(logoutClaims(), other.privateKey), forged.io)).toEqual({ status: 400, ended: 0 });
    expect(forged.calls.subjects).toEqual([]);
    // 서명은 맞아도 sub도 sid도 없는 토큰(이 사람을 찾을 수 없음) — sid만 온 토큰은 0118부터 받는다(batch-0301)
    expect(await handleBackchannelLogout(jwt(logoutClaims({ sub: undefined, sid: undefined })), bcIo().io)).toEqual({ status: 400, ended: 0 });
  });
  it('설정·공개키·직원을 못 읽거나 못 적으면 503(계정 서비스가 다시 보낸다)', async () => {
    const fail = async () => { throw new Error('db'); };
    expect((await handleBackchannelLogout(jwt(logoutClaims()), bcIo({ configsByIssuer: fail }).io)).status).toBe(503);
    expect((await handleBackchannelLogout(jwt(logoutClaims()), bcIo({ fetch: (async () => new Response('x', { status: 500 })) as unknown as typeof fetch }).io)).status).toBe(503);
    expect((await handleBackchannelLogout(jwt(logoutClaims()), bcIo({ publicHost: async () => false }).io)).status).toBe(503);
    expect((await handleBackchannelLogout(jwt(logoutClaims()), bcIo({ subjectUsers: fail }).io)).status).toBe(503);
    expect((await handleBackchannelLogout(jwt(logoutClaims()), bcIo({ markLoggedOut: fail }).io)).status).toBe(503);
  });
});

describe('로그인할 때 sub 적어 두기', () => {
  function loginIo(over: Partial<SsoIo> = {}) {
    let nonce = '';
    let rand = 0;
    const remembered: unknown[] = [];
    const io: SsoIo = {
      loadOrgBySlug: async (slug) => ({ id: 'org-1', slug, status: 'active' }),
      loadConfig: async () => config(),
      decrypt: (s) => s.replace(/^enc:/, ''),
      fetch: (async (input: string, init?: RequestInit) => {
        const url = String(input);
        if (url.endsWith('/.well-known/openid-configuration')) {
          return new Response(JSON.stringify({ issuer: ISSUER, authorization_endpoint: 'https://idp.example.com/auth', token_endpoint: 'https://idp.example.com/token', jwks_uri: 'https://idp.example.com/keys' }));
        }
        if (url === 'https://idp.example.com/token' && init?.method === 'POST') {
          return new Response(JSON.stringify({ id_token: jwt({ iss: ISSUER, aud: CLIENT, exp: NOW / 1000 + 600, iat: NOW / 1000, nonce, sub: 'kc-user-1', email: 'kim@agency.go.kr' }) }));
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
      rememberSubject: async (a) => { remembered.push(a); },
      ...over,
    };
    const run = async () => {
      const started = await startSso('agency', io, APP, SECRET);
      const auth = new URL(started.redirect);
      nonce = auth.searchParams.get('nonce')!;
      return finishSso(new URLSearchParams({ code: 'C', state: auth.searchParams.get('state')! }), started.stateCookie, io, APP, SECRET);
    };
    return { run, remembered };
  }
  it('기관·발급자·sub → 직원을 적는다', async () => {
    const { run, remembered } = loginIo();
    expect(await run()).toEqual({ redirect: '/', session: 'SESSION' });
    expect(remembered).toEqual([{ organizationId: 'org-1', issuer: ISSUER, subject: 'kc-user-1', userId: 'u1' }]);
  });
  it('못 적어도 로그인은 그대로', async () => {
    const { run } = loginIo({ rememberSubject: async () => { throw new Error('db'); } });
    expect(await run()).toEqual({ redirect: '/', session: 'SESSION' });
  });
});

describe('미들웨어가 끝내기', () => {
  const SUB = '11111111-1111-4111-8111-111111111111';
  const LOGOUT = NOW;
  const status: UserStatus = { kind: 'active', role: 'USER', departmentId: 'd1', ssoLogoutAt: LOGOUT };
  const verdict = (token: Record<string, unknown>) => userSessionVerdict(new Map(), { sub: SUB, role: 'USER', departmentId: 'd1', ...token }, async () => status, NOW + 1000);
  it('그때나 그 전에 기관 계정으로 들어온 로그인만 끝낸다', async () => {
    expect(await verdict({ sso: true, authAt: LOGOUT - 60_000 })).toBe('sso_logged_out');
    expect(await verdict({ sso: true, authAt: LOGOUT })).toBe('sso_logged_out');
    expect(await verdict({ sso: true, authAt: LOGOUT + 2000 })).toBe('ok');
    // 비밀번호 로그인·대리 접근은 그대로
    expect(await verdict({ authAt: LOGOUT - 60_000 })).toBe('ok');
    expect(await verdict({ sso: true, isImpersonating: true, authAt: LOGOUT - 60_000 })).toBe('ok');
    expect(await userSessionVerdict(new Map(), { sub: SUB, role: 'USER', departmentId: 'd1', sso: true, authAt: 1 }, async () => ({ ...status, ssoLogoutAt: null }), NOW)).toBe('ok');
  });
  it('계정 상태를 읽을 때 sso_logout_at도 읽는다', async () => {
    const f = vi.fn(async () => new Response(JSON.stringify([{ role: 'user', department_id: 'd1', is_active: true, deleted_at: null, sso_logout_at: '2026-11-25T03:00:00Z' }])));
    expect(await readUserStatus({ url: 'https://x.supabase.co', key: 'k' } as never, SUB, f as never)).toMatchObject({ kind: 'active', ssoLogoutAt: LOGOUT });
    expect(String((f.mock.calls[0] as unknown[])[0])).toContain(',sso_logout_at');
  });
  it('로그인 화면의 안내', () => {
    expect(ssoErrorMessage('sso_logged_out')).toContain('로그아웃');
    const mw = readFileSync('src/middleware.ts', 'utf8');
    expect(mw).toContain("verdict === 'sso_logged_out' ? 'sso_logged_out'");
    expect(mw).toContain("pathname === '/api/sso/backchannel-logout'");
  });
});

describe('잇기', () => {
  it('라우트·등록·관리자 화면·보안 로그 이름표', () => {
    const route = readFileSync('src/app/api/sso/backchannel-logout/route.ts', 'utf8');
    expect(route).toContain('export async function POST');
    expect(route).toContain("get('logout_token')");
    expect(API_ROUTES).toContain('sso/backchannel-logout');
    expect(readFileSync('src/app/api/admin/sso/route.ts', 'utf8')).toContain('backchannelUri: `${appBaseUrl()}${SSO_BACKCHANNEL_PATH}`');
    expect(readFileSync('src/components/admin/OrgSsoPanel.tsx', 'utf8')).toContain('loaded.backchannelUri');
    expect(SECURITY_EVENT_LABELS.sso_backchannel_logout).toBeTruthy();
    const lib = readFileSync('src/lib/org-sso.ts', 'utf8');
    // 다시 온 옛 토큰이 새 로그인을 끝내지 않게 — 더 늦을 때만 적는다
    expect(lib).toContain('.or(`sso_logout_at.is.null,sso_logout_at.lt."${at}"`)');
  });
});

const dbUrl = process.env.WORK_TEST_DATABASE_URL;
describe.skipIf(!dbUrl)('0114 — sub 표·로그아웃 시각(시험 DB)', () => {
  let db: pg.Client;
  beforeAll(async () => {
    if (/supabase\.(co|com)|pooler\./.test(dbUrl!)) throw new Error('운영 DB 주소로 보입니다 — 시험 DB를 쓰세요');
    db = new pg.Client({ connectionString: dbUrl });
    await db.connect();
  });
  afterAll(async () => { await db?.end(); });
  it('여러 번 적용해도 안전·RLS·칸 길이', async () => {
    expect(existsSync('supabase/migrations/0114_org_sso_backchannel_logout.sql')).toBe(true);
    await db.query('BEGIN');
    try {
      const sql = readFileSync('supabase/migrations/0114_org_sso_backchannel_logout.sql', 'utf8');
      await db.query(sql); await db.query(sql);
      expect((await db.query("SELECT relrowsecurity FROM pg_class WHERE relname = 'org_sso_subjects'")).rows).toEqual([{ relrowsecurity: true }]);
      expect((await db.query("SELECT 1 FROM information_schema.columns WHERE table_name = 'users' AND column_name = 'sso_logout_at'")).rowCount).toBe(1);
      const orgId = randomUUID();
      const deptId = randomUUID();
      const userId = randomUUID();
      await db.query('INSERT INTO organizations (id, name) VALUES ($1, $2)', [orgId, '0114 기관']);
      await db.query('INSERT INTO departments (id, name, slug, organization_id) VALUES ($1, $2, $3, $4)', [deptId, '0114 부서', `d-${deptId.slice(0, 8)}`, orgId]);
      await db.query('INSERT INTO users (id, email, department_id) VALUES ($1, $2, $3)', [userId, `u-${userId.slice(0, 8)}@x.test`, deptId]);
      const ins = (subject: string) => db.query(
        'INSERT INTO org_sso_subjects (organization_id, issuer, subject, user_id) VALUES ($1, $2, $3, $4) ON CONFLICT (organization_id, issuer, subject) DO UPDATE SET user_id = EXCLUDED.user_id',
        [orgId, ISSUER, subject, userId]);
      await ins('kc-user-1');
      await ins('kc-user-1');
      expect((await db.query('SELECT count(*)::int AS n FROM org_sso_subjects WHERE organization_id = $1', [orgId])).rows).toEqual([{ n: 1 }]);
      for (const subject of ['', 'x'.repeat(256)]) {
        await db.query('SAVEPOINT s');
        await expect(ins(subject)).rejects.toThrow(/check/i);
        await db.query('ROLLBACK TO SAVEPOINT s');
      }
    } finally {
      await db.query('ROLLBACK');
    }
  });
});
