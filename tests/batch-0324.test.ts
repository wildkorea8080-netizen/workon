// tests/batch-0324.test.ts
// 기관 SSO 호환 넓히기(2026-11-26) — id_token 서명 RS·PS·ES 256/384/512, 토큰 주소 인증 client_secret_post·_basic(발견 문서로 고름).
import { createSign, generateKeyPairSync, sign as cryptoSign, constants, type KeyObject } from 'crypto';
import { describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/supabaseAdmin', () => ({ supabaseAdmin: {} }));
vi.mock('@/lib/config', () => ({ NEXTAUTH_SECRET: 'test-secret', NEXTAUTH_URL: 'https://workon.test', SUPABASE_DOCUMENTS_BUCKET: 'documents', NODA_API_URL: 'https://noda.test', NODA_API_KEY: '' }));
vi.mock('@/lib/logger', () => ({ logSystem: vi.fn(async () => {}) }));
vi.mock('@/lib/crypto', () => ({ decryptApiKey: (s: string) => s.replace(/^enc:/, ''), encryptApiKey: (s: string) => `enc:${s}`, EncryptionKeyMissingError: class extends Error {} }));

import {
  SSO_JWT_ALGS, basicAuthHeader, finishSso, pickTokenAuth, saveSsoConfig, startSso, verifyIdToken, type SsoConfigRow, type SsoIo, type SsoUserRow,
} from '@/lib/org-sso';

const ISSUER = 'https://login.example.com/tenant';
const CLIENT = 'client 1:x';
const ORG = 'org-1';
const NOW = Date.parse('2026-11-26T03:00:00Z');
const APP = 'https://workon.test';
const SECRET = 'test-secret';
const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url');

const rsa = generateKeyPairSync('rsa', { modulusLength: 2048 });
const p384 = generateKeyPairSync('ec', { namedCurve: 'P-384' });
const p521 = generateKeyPairSync('ec', { namedCurve: 'P-521' });
const jwk = (k: KeyObject, kid: string) => ({ ...(k.export({ format: 'jwk' }) as Record<string, unknown>), kid, use: 'sig' });
const keys = [jwk(rsa.publicKey, 'r'), jwk(p384.publicKey, 'e384'), jwk(p521.publicKey, 'e521')] as never[];

function token(claims: Record<string, unknown>, alg: string, kid: string): string {
  const head = `${b64({ alg, kid, typ: 'JWT' })}.${b64(claims)}`;
  const data = Buffer.from(head);
  const hash = `sha${alg.slice(2)}`;
  let sig: Buffer;
  if (alg.startsWith('RS')) sig = createSign(`RSA-SHA${alg.slice(2)}`).update(head).sign(rsa.privateKey);
  else if (alg.startsWith('PS')) sig = cryptoSign(hash, data, { key: rsa.privateKey, padding: constants.RSA_PKCS1_PSS_PADDING, saltLength: constants.RSA_PSS_SALTLEN_DIGEST });
  else sig = cryptoSign(hash, data, { key: (alg === 'ES384' ? p384 : p521).privateKey, dsaEncoding: 'ieee-p1363' });
  return `${head}.${sig.toString('base64url')}`;
}
const claims = (over: Record<string, unknown> = {}) => ({ iss: ISSUER, aud: CLIENT, exp: NOW / 1000 + 600, iat: NOW / 1000 - 5, nonce: 'N1', sub: 'abc', email: 'kim@agency.go.kr', ...over });
const verify = (t: string) => verifyIdToken(t, { issuer: ISSUER, clientId: CLIENT, nonce: 'N1', keys, nowMs: NOW });

describe('서명 알고리즘', () => {
  it('RS·PS 256/384/512, ES384·ES512를 받는다', () => {
    for (const [alg, kid] of [['RS256', 'r'], ['RS384', 'r'], ['RS512', 'r'], ['PS256', 'r'], ['PS384', 'r'], ['PS512', 'r'], ['ES384', 'e384'], ['ES512', 'e521']]) {
      expect(verify(token(claims(), alg, kid)).ok, alg).toBe(true);
    }
    expect(Object.keys(SSO_JWT_ALGS)).toHaveLength(9);
  });
  it('none·HS256은 받지 않고, 곡선이 다른 키·바꾼 내용은 거절', () => {
    const head = `${b64({ alg: 'none', kid: 'r' })}.${b64(claims())}.`;
    expect(verify(head)).toEqual({ ok: false, reason: 'alg' });
    expect(verify(`${b64({ alg: 'HS256', kid: 'r' })}.${b64(claims())}.x`)).toEqual({ ok: false, reason: 'alg' });
    // ES384 서명을 P-521 키 이름으로 — 곡선이 맞는 키가 없다
    expect(verify(token(claims(), 'ES384', 'e521'))).toEqual({ ok: false, reason: 'no_key' });
    const t = token(claims(), 'PS256', 'r').split('.');
    expect(verify(`${t[0]}.${b64(claims({ email: 'evil@agency.go.kr' }))}.${t[2]}`)).toEqual({ ok: false, reason: 'signature' });
  });
});

describe('토큰 주소 인증 방식', () => {
  it('post 먼저, 없으면 basic, 목록이 없으면 예전처럼 post, 둘 다 없으면 null', () => {
    expect(pickTokenAuth(['client_secret_basic', 'client_secret_post'])).toBe('client_secret_post');
    expect(pickTokenAuth(['client_secret_basic', 'private_key_jwt'])).toBe('client_secret_basic');
    expect(pickTokenAuth(undefined)).toBe('client_secret_post');
    expect(pickTokenAuth(['private_key_jwt'])).toBeNull();
  });
  it('basic 머리글 — 아이디·비밀값을 각각 폼 인코딩한 뒤 이어 base64', () => {
    const h = basicAuthHeader('client 1:x', 'p@ss w');
    expect(Buffer.from(h.slice(6), 'base64').toString()).toBe('client+1%3Ax:p%40ss+w');
  });
});

const config = (over: Partial<SsoConfigRow> = {}): SsoConfigRow => ({
  organization_id: ORG, issuer: ISSUER, client_id: CLIENT, client_secret_encrypted: 'enc:shh', email_domains: [], enabled: true, button_label: null, updated_at: null, ...over,
});
const user: SsoUserRow = { id: 'u1', email: 'kim@agency.go.kr', full_name: '김', role: 'USER', department_id: 'd1', is_active: true, deleted_at: null, is_super_admin: false };

function fakeIo(discoveryExtra: Record<string, unknown>, alg = 'PS256', kid = 'r') {
  const calls: { url: string; body?: string; headers?: Record<string, string> }[] = [];
  let nonce = '';
  let rand = 0;
  const io: SsoIo = {
    loadOrgBySlug: async (slug) => (slug === 'agency' ? { id: ORG, slug, status: 'active' } : null),
    loadConfig: async () => config(),
    decrypt: (s) => s.replace(/^enc:/, ''),
    fetch: (async (input: string, init?: RequestInit) => {
      const url = String(input);
      calls.push({ url, body: typeof init?.body === 'string' ? init.body : undefined, headers: init?.headers as Record<string, string> });
      if (url.endsWith('/.well-known/openid-configuration')) {
        return new Response(JSON.stringify({ issuer: ISSUER, authorization_endpoint: 'https://login.example.com/authorize', token_endpoint: 'https://login.example.com/token', jwks_uri: 'https://login.example.com/keys', ...discoveryExtra }));
      }
      if (url === 'https://login.example.com/token') return new Response(JSON.stringify({ id_token: token(claims({ nonce }), alg, kid) }));
      if (url === 'https://login.example.com/keys') return new Response(JSON.stringify({ keys }));
      return new Response('nope', { status: 404 });
    }) as unknown as typeof fetch,
    publicHost: async () => true,
    findUser: async () => user,
    lockIfDormant: async () => false,
    record: async () => {},
    mintSession: async () => 'SESSION',
    now: () => NOW,
    random: (n) => Buffer.alloc(n, ++rand),
  } as SsoIo;
  return {
    io, calls,
    async run() {
      const started = await startSso('agency', io, APP, SECRET);
      const auth = new URL(started.redirect);
      nonce = auth.searchParams.get('nonce')!;
      return finishSso(new URLSearchParams({ code: 'CODE', state: auth.searchParams.get('state')! }), started.stateCookie, io, APP, SECRET);
    },
  };
}

describe('흐름', () => {
  it('basic만 받는 계정 서비스 — 비밀값은 머리글에만, 몸에는 싣지 않는다(PS256 id_token)', async () => {
    const f = fakeIo({ token_endpoint_auth_methods_supported: ['client_secret_basic'] });
    expect(await f.run()).toEqual({ redirect: '/', session: 'SESSION' });
    const req = f.calls.find((c) => c.url.endsWith('/token'))!;
    expect(req.headers?.Authorization).toBe(basicAuthHeader(CLIENT, 'shh'));
    expect(new URLSearchParams(req.body).get('client_secret')).toBeNull();
    expect(new URLSearchParams(req.body).get('client_id')).toBe(CLIENT);
  });
  it('post — 예전처럼 몸에, 머리글 없음(ES512 id_token)', async () => {
    const f = fakeIo({ token_endpoint_auth_methods_supported: ['client_secret_post', 'client_secret_basic'] }, 'ES512', 'e521');
    expect(await f.run()).toEqual({ redirect: '/', session: 'SESSION' });
    const req = f.calls.find((c) => c.url.endsWith('/token'))!;
    expect(new URLSearchParams(req.body).get('client_secret')).toBe('shh');
    expect(req.headers?.Authorization).toBeUndefined();
  });
  it('둘 다 안 받는 곳은 토큰 교환을 하지 않는다', async () => {
    const f = fakeIo({ token_endpoint_auth_methods_supported: ['private_key_jwt'] });
    expect((await f.run()).redirect).toBe('/signin/agency?error=sso_unavailable');
    expect(f.calls.some((c) => c.url.endsWith('/token'))).toBe(false);
  });
});

describe('켤 때 확인', () => {
  const base = { issuer: ISSUER, clientId: CLIENT, clientSecret: 'shh', emailDomains: [], enabled: true, ssoOnly: false, buttonLabel: '기관 계정', groupClaim: null, groupMappings: [], adminGroups: [], singleLogout: false };
  const io = (extra: Record<string, unknown>) => ({
    loadConfig: async () => null,
    fetch: (async () => new Response(JSON.stringify({ issuer: ISSUER, authorization_endpoint: 'https://login.example.com/a', token_endpoint: 'https://login.example.com/t', jwks_uri: 'https://login.example.com/k', ...extra }))) as unknown as typeof fetch,
    publicHost: async () => true,
    now: () => NOW,
    upsert: vi.fn(async (row: Record<string, unknown>) => row as unknown as SsoConfigRow),
    encrypt: (s: string) => `enc:${s}`,
  });
  it('토큰 인증 방식·서명 알고리즘이 맞지 않으면 켜지 않는다', async () => {
    expect(await saveSsoConfig(ORG, 'u', base as never, io({ token_endpoint_auth_methods_supported: ['private_key_jwt'] }) as never)).toMatchObject({ ok: false, status: 400, message: expect.stringContaining('client_secret_basic') });
    expect(await saveSsoConfig(ORG, 'u', base as never, io({ id_token_signing_alg_values_supported: ['EdDSA'] }) as never)).toMatchObject({ ok: false, status: 400, message: expect.stringContaining('서명 알고리즘') });
    expect((await saveSsoConfig(ORG, 'u', base as never, io({ id_token_signing_alg_values_supported: ['RS256', 'EdDSA'], token_endpoint_auth_methods_supported: ['client_secret_basic'] }) as never)).ok).toBe(true);
  });
});
