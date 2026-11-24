import { readFileSync, existsSync } from 'fs';
import { createSign, generateKeyPairSync, sign as cryptoSign, randomUUID, type KeyObject } from 'crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import pg from 'pg';

/**
 * 2026-11-25 — 기관 SSO(OIDC, 0107). 인가 코드 + PKCE, id_token 서명·클레임 검증, 이 기관에 이미 등록된 직원만 들인다.
 * 서명은 시험에서 실제 RSA·EC 키로 만들고 공개키(JWK)로 검증한다.
 */

vi.mock('@/lib/supabaseAdmin', () => ({ supabaseAdmin: {} }));
vi.mock('@/lib/config', () => ({ NEXTAUTH_SECRET: 'test-secret', NEXTAUTH_URL: 'https://workon.test', SUPABASE_DOCUMENTS_BUCKET: 'documents', NODA_API_URL: 'https://noda.test', NODA_API_KEY: '' }));
vi.mock('@/lib/logger', () => ({ logSystem: vi.fn(async () => {}) }));
vi.mock('@/lib/crypto', () => ({ decryptApiKey: (s: string) => s.replace(/^enc:/, ''), encryptApiKey: (s: string) => `enc:${s}`, EncryptionKeyMissingError: class extends Error {} }));

import {
  finishSso, normalizeIssuer, openState, parseSsoConfig, pkceChallenge, saveSsoConfig, sealState, ssoEmail, ssoErrorMessage, startSso, verifyIdToken,
  SSO_DEFAULT_LABEL, type SsoConfigRow, type SsoIo, type SsoUserRow,
} from '@/lib/org-sso';
import { userSessionVerdict } from '@/lib/middleware-db';
import { API_ROUTES, NON_UUID_SEGMENTS } from '@/lib/api-route-ids';

const ISSUER = 'https://login.example.com/tenant/v2.0';
const CLIENT = 'client-123';
const ORG = 'org-1';
const NOW = Date.parse('2026-11-25T03:00:00Z');
const APP = 'https://workon.test';
const SECRET = 'test-secret';

const rsa = generateKeyPairSync('rsa', { modulusLength: 2048 });
const rsaJwk = { ...(rsa.publicKey.export({ format: 'jwk' }) as Record<string, unknown>), kid: 'k1', use: 'sig', alg: 'RS256' };
const ec = generateKeyPairSync('ec', { namedCurve: 'P-256' });
const ecJwk = { ...(ec.publicKey.export({ format: 'jwk' }) as Record<string, unknown>), kid: 'e1' };
const other = generateKeyPairSync('rsa', { modulusLength: 2048 });

const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url');
function jwt(claims: Record<string, unknown>, opts: { alg?: string; kid?: string; key?: KeyObject } = {}): string {
  const alg = opts.alg ?? 'RS256';
  const head = `${b64({ alg, kid: opts.kid ?? (alg === 'ES256' ? 'e1' : 'k1'), typ: 'JWT' })}.${b64(claims)}`;
  let sig: Buffer;
  if (alg === 'ES256') sig = cryptoSign('sha256', Buffer.from(head), { key: opts.key ?? ec.privateKey, dsaEncoding: 'ieee-p1363' });
  else if (alg === 'RS256') sig = createSign('RSA-SHA256').update(head).sign(opts.key ?? rsa.privateKey);
  else sig = Buffer.from('x');
  return `${head}.${sig.toString('base64url')}`;
}
const claims = (over: Record<string, unknown> = {}) => ({
  iss: ISSUER, aud: CLIENT, exp: NOW / 1000 + 600, iat: NOW / 1000 - 5, nonce: 'N1', sub: 'abc', email: 'Kim@Agency.go.kr', ...over,
});
const keys = [rsaJwk, ecJwk] as never[];
const verify = (token: string, nonce = 'N1') => verifyIdToken(token, { issuer: ISSUER, clientId: CLIENT, nonce, keys, nowMs: NOW });

describe('설정 검사', () => {
  it('발급자 https·끝 / 뗌, 클라이언트 ID, 비밀값은 비우면 그대로, 도메인·단추 글', () => {
    expect(normalizeIssuer('https://a.example.com/x/')).toBe('https://a.example.com/x');
    expect(normalizeIssuer('http://a.example.com')).toBeNull();
    expect(normalizeIssuer('https://u:p@a.example.com')).toBeNull();
    expect(parseSsoConfig({ issuer: 'https://a.example.com/', clientId: ' c1 ', emailDomains: '@Agency.go.kr, agency.go.kr', enabled: true }))
      .toEqual({ ok: true, value: { issuer: 'https://a.example.com', clientId: 'c1', clientSecret: null, emailDomains: ['agency.go.kr'], enabled: true, ssoOnly: false, buttonLabel: SSO_DEFAULT_LABEL } });
    expect(parseSsoConfig({ issuer: 'ftp://a', clientId: 'c' }).ok).toBe(false);
    expect(parseSsoConfig({ issuer: 'https://a.example.com', clientId: 'a b' }).ok).toBe(false);
    expect(parseSsoConfig({ issuer: 'https://a.example.com', clientId: 'c', emailDomains: ['not a domain'] }).ok).toBe(false);
    expect(parseSsoConfig({ issuer: 'https://a.example.com', clientId: 'c', enabled: 'yes' }).ok).toBe(false);
    expect(parseSsoConfig({ issuer: 'https://a.example.com', clientId: 'c', buttonLabel: '가'.repeat(31) }).ok).toBe(false);
    expect(ssoErrorMessage('sso_no_account')).toContain('등록');
    expect(ssoErrorMessage('unauthorized')).toBeNull();
  });
});

describe('상태 쿠키', () => {
  const st = { org: ORG, slug: 'agency', state: 's', nonce: 'n', verifier: 'v', exp: NOW + 60_000 };
  it('서명이 맞고 기한 안이면 열린다, 바꾸거나 지나면 안 열린다', () => {
    const sealed = sealState(st, SECRET);
    expect(openState(sealed, SECRET, NOW)).toEqual(st);
    expect(openState(sealed, 'other', NOW)).toBeNull();
    expect(openState(sealed, SECRET, NOW + 120_000)).toBeNull();
    const [body, mac] = sealed.split('.');
    const forged = Buffer.from(JSON.stringify({ ...st, org: 'org-2' })).toString('base64url');
    expect(openState(`${forged}.${mac}`, SECRET, NOW)).toBeNull();
    expect(openState(`${body}`, SECRET, NOW)).toBeNull();
    expect(openState(null, SECRET, NOW)).toBeNull();
  });
  it('PKCE S256', () => {
    // RFC 7636 부록 B의 예
    expect(pkceChallenge('dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk')).toBe('E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM');
  });
});

describe('id_token 검증', () => {
  it('RS256·ES256의 맞는 서명·클레임은 받는다', () => {
    expect(verify(jwt(claims()))).toMatchObject({ ok: true, claims: { sub: 'abc' } });
    expect(verify(jwt(claims(), { alg: 'ES256' }))).toMatchObject({ ok: true });
    // aud가 여럿이면 azp가 클라이언트여야
    expect(verify(jwt(claims({ aud: [CLIENT, 'other'], azp: CLIENT })))).toMatchObject({ ok: true });
  });
  it('서명·알고리즘·키가 틀리면 거절', () => {
    expect(verify(jwt(claims(), { key: other.privateKey }))).toEqual({ ok: false, reason: 'signature' });
    expect(verify(jwt(claims(), { kid: 'nope' }))).toEqual({ ok: false, reason: 'no_key' });
    expect(verify(jwt(claims(), { alg: 'HS256' }))).toEqual({ ok: false, reason: 'alg' });
    expect(verify(jwt(claims(), { alg: 'none' }))).toEqual({ ok: false, reason: 'alg' });
    const t = jwt(claims());
    const [h, , s] = t.split('.');
    expect(verify(`${h}.${b64(claims({ email: 'boss@agency.go.kr' }))}.${s}`)).toEqual({ ok: false, reason: 'signature' });
    expect(verify('a.b')).toEqual({ ok: false, reason: 'format' });
  });
  it('iss·aud·azp·exp·iat·nonce', () => {
    expect(verify(jwt(claims({ iss: 'https://evil.example.com' })))).toEqual({ ok: false, reason: 'iss' });
    expect(verify(jwt(claims({ aud: 'someone-else' })))).toEqual({ ok: false, reason: 'aud' });
    expect(verify(jwt(claims({ aud: [CLIENT, 'other'], azp: 'other' })))).toEqual({ ok: false, reason: 'azp' });
    expect(verify(jwt(claims({ exp: NOW / 1000 - 300 })))).toEqual({ ok: false, reason: 'exp' });
    expect(verify(jwt(claims({ iat: NOW / 1000 + 600 })))).toEqual({ ok: false, reason: 'iat' });
    expect(verify(jwt(claims()), 'N2')).toEqual({ ok: false, reason: 'nonce' });
    expect(verify(jwt(claims({ nonce: undefined })))).toEqual({ ok: false, reason: 'nonce' });
  });
  it('이메일 — 검증 표시 false면 email을 쓰지 않음, preferred_username·upn, 허용 도메인', () => {
    expect(ssoEmail({ email: 'Kim@Agency.go.kr' }, [])).toEqual({ ok: true, email: 'kim@agency.go.kr' });
    expect(ssoEmail({ email: 'kim@agency.go.kr', email_verified: false }, [])).toEqual({ ok: false, code: 'sso_no_account' });
    expect(ssoEmail({ email: 'x@evil.com', email_verified: false, preferred_username: 'lee@agency.go.kr' }, [])).toEqual({ ok: true, email: 'lee@agency.go.kr' });
    expect(ssoEmail({ upn: 'park@agency.go.kr' }, ['agency.go.kr'])).toEqual({ ok: true, email: 'park@agency.go.kr' });
    expect(ssoEmail({ email: 'kim@other.com' }, ['agency.go.kr'])).toEqual({ ok: false, code: 'sso_domain' });
    expect(ssoEmail({ preferred_username: 'kim' }, [])).toEqual({ ok: false, code: 'sso_no_account' });
  });
});

// ── 흐름(가짜 계정 서비스) ──
const config = (over: Partial<SsoConfigRow> = {}): SsoConfigRow => ({
  organization_id: ORG, issuer: ISSUER, client_id: CLIENT, client_secret_encrypted: 'enc:shh', email_domains: [], enabled: true, button_label: null, updated_at: null, ...over,
});
const user = (over: Partial<SsoUserRow> = {}): SsoUserRow => ({
  id: 'u1', email: 'kim@agency.go.kr', full_name: '김주무관', role: 'USER', department_id: 'd1', is_active: true, deleted_at: null, is_super_admin: false, ...over,
});

function fakeIo(over: Partial<SsoIo> & { idToken?: (nonce: string) => string; discoveryIssuer?: string } = {}) {
  const calls = { fetch: [] as { url: string; body?: string }[], record: [] as unknown[][], mint: [] as unknown[] };
  let rand = 0;
  const io: SsoIo = {
    loadOrgBySlug: async (slug) => (slug === 'agency' ? { id: ORG, slug, status: 'active' } : null),
    loadConfig: async () => config(),
    decrypt: (s) => s.replace(/^enc:/, ''),
    fetch: (async (input: string, init?: RequestInit) => {
      const url = String(input);
      calls.fetch.push({ url, body: typeof init?.body === 'string' ? init.body : undefined });
      if (url.endsWith('/.well-known/openid-configuration')) {
        return new Response(JSON.stringify({ issuer: over.discoveryIssuer ?? ISSUER, authorization_endpoint: 'https://login.example.com/authorize', token_endpoint: 'https://login.example.com/token', jwks_uri: 'https://login.example.com/keys' }));
      }
      if (url === 'https://login.example.com/token') {
        const nonce = lastNonce;
        return new Response(JSON.stringify({ id_token: (over.idToken ?? ((n) => jwt(claims({ nonce: n }))))(nonce), access_token: 'at' }));
      }
      if (url === 'https://login.example.com/keys') return new Response(JSON.stringify({ keys }));
      return new Response('nope', { status: 404 });
    }) as unknown as typeof fetch,
    publicHost: async () => true,
    findUser: async () => user(),
    lockIfDormant: async () => false,
    record: async (...a) => { calls.record.push(a); },
    mintSession: async (u) => { calls.mint.push(u); return 'SESSION'; },
    now: () => NOW,
    random: (n) => Buffer.alloc(n, ++rand),
    ...over,
  };
  return { io, calls };
}
let lastNonce = '';

async function startAndBack(io: SsoIo, tamper?: (q: URLSearchParams) => void) {
  const started = await startSso('agency', io, APP, SECRET);
  const auth = new URL(started.redirect);
  lastNonce = auth.searchParams.get('nonce')!;
  const q = new URLSearchParams({ code: 'CODE', state: auth.searchParams.get('state')! });
  tamper?.(q);
  return { started, auth, done: await finishSso(q, started.stateCookie, io, APP, SECRET) };
}

describe('흐름', () => {
  it('시작 — 인가 주소에 클라이언트·돌아올 주소·state·nonce·S256 챌린지, 상태 쿠키의 verifier와 짝', async () => {
    const { io } = fakeIo();
    const { started, auth } = await startAndBack(io);
    expect(auth.origin + auth.pathname).toBe('https://login.example.com/authorize');
    expect(Object.fromEntries(auth.searchParams)).toMatchObject({ response_type: 'code', client_id: CLIENT, redirect_uri: `${APP}/api/sso/callback`, scope: 'openid email profile', code_challenge_method: 'S256' });
    const st = openState(started.stateCookie, SECRET, NOW)!;
    expect(auth.searchParams.get('code_challenge')).toBe(pkceChallenge(st.verifier));
    expect(st).toMatchObject({ org: ORG, slug: 'agency', state: auth.searchParams.get('state'), nonce: auth.searchParams.get('nonce') });
  });
  it('돌아옴 — 코드·verifier·비밀값으로 교환, 서명 확인, 등록된 직원의 세션을 만든다', async () => {
    const { io, calls } = fakeIo();
    const { done } = await startAndBack(io);
    expect(done).toEqual({ redirect: '/', session: 'SESSION' });
    const token = calls.fetch.find((f) => f.url === 'https://login.example.com/token')!;
    const form = new URLSearchParams(token.body);
    expect(Object.fromEntries(form)).toMatchObject({ grant_type: 'authorization_code', code: 'CODE', client_id: CLIENT, client_secret: 'shh', redirect_uri: `${APP}/api/sso/callback` });
    expect(form.get('code_verifier')).toBeTruthy();
    expect(calls.mint[0]).toEqual({ id: 'u1', email: 'kim@agency.go.kr', name: '김주무관', role: 'USER', departmentId: 'd1' });
    expect(calls.record.at(-1)).toEqual(['login', 'kim@agency.go.kr', { id: 'u1', departmentId: 'd1' }]);
  });
  it('state가 다르거나 쿠키가 없으면 sso_expired, 거절·코드 없음은 sso_denied — 토큰 교환을 하지 않는다', async () => {
    const a = fakeIo();
    expect((await startAndBack(a.io, (q) => q.set('state', 'forged'))).done.redirect).toBe('/signin/agency?error=sso_expired');
    expect(a.calls.fetch.some((f) => f.url.endsWith('/token'))).toBe(false);
    expect((await startAndBack(fakeIo().io, (q) => { q.delete('code'); q.set('error', 'access_denied'); })).done.redirect).toBe('/signin/agency?error=sso_denied');
    expect((await finishSso(new URLSearchParams({ code: 'c', state: 's' }), undefined, fakeIo().io, APP, SECRET)).redirect).toBe('/login?error=sso_expired');
  });
  it('id_token이 틀리면(서명·nonce) 세션을 만들지 않는다', async () => {
    const bad = fakeIo({ idToken: (n) => jwt(claims({ nonce: n }), { key: other.privateKey }) });
    expect((await startAndBack(bad.io)).done).toEqual({ redirect: '/signin/agency?error=sso_unavailable' });
    expect(bad.calls.mint).toHaveLength(0);
    const replay = fakeIo({ idToken: () => jwt(claims({ nonce: 'old' })) });
    expect((await startAndBack(replay.io)).done.redirect).toBe('/signin/agency?error=sso_unavailable');
  });
  it('등록 안 됨·다른 기관·슈퍼관리자는 sso_no_account, 사용 중지·탈퇴는 sso_rejected, 잠긴 계정은 sso_dormant, 도메인 밖은 sso_domain', async () => {
    const cases: [Partial<SsoIo>, string][] = [
      [{ findUser: async () => null }, 'sso_no_account'],
      [{ findUser: async () => user({ is_super_admin: true }) }, 'sso_no_account'],
      [{ findUser: async () => user({ department_id: null }) }, 'sso_no_account'],
      [{ findUser: async () => user({ is_active: false }) }, 'sso_rejected'],
      [{ findUser: async () => user({ deleted_at: '2026-11-01T00:00:00Z' }) }, 'sso_rejected'],
      [{ lockIfDormant: async () => true }, 'sso_dormant'],
      [{ loadConfig: async () => config({ email_domains: ['other.go.kr'] }) }, 'sso_domain'],
    ];
    for (const [over, code] of cases) {
      const { io, calls } = fakeIo(over);
      expect((await startAndBack(io)).done).toEqual({ redirect: `/signin/agency?error=${code}` });
      expect(calls.mint).toHaveLength(0);
      expect(calls.record.at(-1)?.[0]).toBe('login_rejected');
    }
  });
  it('꺼짐·비밀값 없음·정지한 기관·없는 경로·발급자 불일치·내부망 주소는 시작하지 않는다', async () => {
    for (const over of [
      { loadConfig: async () => config({ enabled: false }) },
      { loadConfig: async () => config({ client_secret_encrypted: null }) },
      { loadOrgBySlug: async () => ({ id: ORG, slug: 'agency', status: 'suspended' }) },
      { discoveryIssuer: 'https://evil.example.com' },
      { publicHost: async () => false },
    ] as Partial<SsoIo>[]) {
      const out = await startSso('agency', fakeIo(over).io, APP, SECRET);
      expect(out).toEqual({ redirect: '/signin/agency?error=sso_unavailable' });
    }
    expect(await startSso('nobody', fakeIo().io, APP, SECRET)).toEqual({ redirect: '/signin/nobody?error=sso_unavailable' });
  });
});

describe('관리자 설정 저장', () => {
  const adminIo = (before: SsoConfigRow | null, over: Record<string, unknown> = {}) => {
    const upserts: Record<string, unknown>[] = [];
    const { io } = fakeIo();
    return {
      upserts,
      io: { loadConfig: async () => before, fetch: io.fetch, publicHost: io.publicHost, now: () => NOW, encrypt: (s: string) => `enc:${s}`,
        upsert: async (row: Record<string, unknown>) => { upserts.push(row); return { ...config(), ...row } as SsoConfigRow; }, ...over },
    };
  };
  const input = (over: Record<string, unknown> = {}) => ({ issuer: ISSUER, clientId: CLIENT, clientSecret: null, emailDomains: [], enabled: true, ssoOnly: false, buttonLabel: SSO_DEFAULT_LABEL, ...over });
  it('켤 때는 비밀값이 있어야 하고, 발견 문서를 읽지 못하면 저장하지 않는다', async () => {
    expect(await saveSsoConfig(ORG, 'admin', input(), adminIo(null).io)).toMatchObject({ ok: false, status: 400 });
    const failing = adminIo(null, { publicHost: async () => false });
    expect(await saveSsoConfig(ORG, 'admin', input({ clientSecret: 's' }), failing.io)).toMatchObject({ ok: false, status: 400 });
    expect(failing.upserts).toHaveLength(0);
  });
  it('비밀값은 암호화해 저장하고, 비우면 그대로 둔다 — 응답·바뀐 칸에 비밀값 없음', async () => {
    const first = adminIo(null);
    const r = await saveSsoConfig(ORG, 'admin', input({ clientSecret: 'shh' }), first.io);
    expect(first.upserts[0]).toMatchObject({ client_secret_encrypted: 'enc:shh', enabled: true, updated_by: 'admin', button_label: null });
    expect(r).toMatchObject({ ok: true, changed: ['issuer', 'client_id', 'client_secret', 'email_domains', 'enabled', 'button_label'] });
    expect(JSON.stringify(r)).not.toContain('shh');
    const again = adminIo(config({ client_secret_encrypted: 'enc:old' }));
    const r2 = await saveSsoConfig(ORG, 'admin', input({ enabled: false }), again.io);
    expect(again.upserts[0]).toMatchObject({ client_secret_encrypted: 'enc:old', enabled: false });
    expect(r2).toMatchObject({ ok: true, changed: ['enabled'] });
  });
});

describe('잇기', () => {
  it('SSO 로그인은 임시 비밀번호 바꾸기로 묶지 않는다(비밀번호 로그인은 그대로 묶음)', async () => {
    const read = async () => ({ kind: 'active' as const, role: 'USER', departmentId: 'd1', passwordChangedAt: null, mustChangePassword: true });
    expect(await userSessionVerdict(new Map(), { sub: 'u1', role: 'USER', departmentId: 'd1', sso: true }, read as never, NOW)).toBe('ok');
    expect(await userSessionVerdict(new Map(), { sub: 'u1', role: 'USER', departmentId: 'd1' }, read as never, NOW)).toBe('must_change_password');
  });
  it('라우트·공개 목록·화면', () => {
    for (const r of ['sso/[slug]/start', 'sso/callback', 'admin/sso']) expect(API_ROUTES).toContain(r);
    expect(NON_UUID_SEGMENTS.has('[slug]')).toBe(true);
    const auth = readFileSync('tests/route-auth.test.ts', 'utf8');
    expect(auth).toContain("['/sso/[slug]/start'");
    expect(auth).toContain("['/sso/callback'");
    const admin = readFileSync('src/app/api/admin/sso/route.ts', 'utf8');
    expect(admin.match(/isAdminSession\(session\)/g)).toHaveLength(2);
    expect(admin).toContain('managesWholeOrganization');
    expect(admin).toContain('isImpersonating');
    const cb = readFileSync('src/app/api/sso/callback/route.ts', 'utf8');
    expect(cb).toContain("res.cookies.set({ name: SSO_STATE_COOKIE, value: '', maxAge: 0, path: '/api/sso' })");
    expect(readFileSync('src/components/auth/LoginForm.tsx', 'utf8')).toContain('/api/sso/${encodeURIComponent(slug)}/start');
    expect(readFileSync('src/app/signin/[slug]/page.tsx', 'utf8')).toContain('ssoLoginForSlug(params.slug)');
    // 계정을 만드는 길이 없다
    const lib = readFileSync('src/lib/org-sso.ts', 'utf8');
    expect(lib).not.toMatch(/from\('users'\)\.(insert|upsert|update)/);
  });
});

const dbUrl = process.env.WORK_TEST_DATABASE_URL;
describe.skipIf(!dbUrl)('0107 — 기관 SSO 표(시험 DB)', () => {
  let db: pg.Client;
  beforeAll(async () => {
    if (/supabase\.(co|com)|pooler\./.test(dbUrl!)) throw new Error('운영 DB 주소로 보입니다 — 시험 DB를 쓰세요');
    db = new pg.Client({ connectionString: dbUrl });
    await db.connect();
  });
  afterAll(async () => { await db?.end(); });
  it('여러 번 적용해도 안전·RLS·https 발급자·켜면 비밀값 필수', async () => {
    expect(existsSync('supabase/migrations/0107_org_sso.sql')).toBe(true);
    await db.query('BEGIN');
    try {
      const sql = readFileSync('supabase/migrations/0107_org_sso.sql', 'utf8');
      await db.query(sql); await db.query(sql);
      expect((await db.query("SELECT relrowsecurity FROM pg_class WHERE relname = 'org_sso_providers'")).rows).toEqual([{ relrowsecurity: true }]);
      const orgId = randomUUID();
      await db.query('INSERT INTO organizations (id, name) VALUES ($1, $2)', [orgId, '0107 기관']);
      const ins = (issuer: string, enabled: boolean, secret: string | null) => db.query(
        'INSERT INTO org_sso_providers (organization_id, issuer, client_id, client_secret_encrypted, enabled) VALUES ($1, $2, $3, $4, $5) ON CONFLICT (organization_id) DO UPDATE SET issuer = EXCLUDED.issuer, enabled = EXCLUDED.enabled, client_secret_encrypted = EXCLUDED.client_secret_encrypted',
        [orgId, issuer, 'c', secret, enabled]);
      await ins('https://login.example.com', false, null);
      await ins('https://login.example.com', true, 'enc');
      for (const [issuer, enabled, secret] of [['http://login.example.com', false, null], ['https://login.example.com', true, null]] as const) {
        await db.query('SAVEPOINT s');
        await expect(ins(issuer, enabled, secret)).rejects.toThrow(/check/i);
        await db.query('ROLLBACK TO SAVEPOINT s');
      }
    } finally {
      await db.query('ROLLBACK');
    }
  });
});
