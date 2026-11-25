import { readFileSync, existsSync } from 'fs';
import { randomUUID } from 'crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import pg from 'pg';

/**
 * 2026-11-25 — 기관 SSO 함께 로그아웃(0111). 기관 계정으로 들어온 직원이 로그아웃하면, 기관이 켰을 때만 계정 서비스의 로그아웃 주소
 * (OIDC RP-Initiated Logout — end_session_endpoint + client_id + post_logout_redirect_uri)로 보내 그쪽 로그인도 끝낸다.
 */

vi.mock('@/lib/supabaseAdmin', () => ({ supabaseAdmin: {} }));
vi.mock('@/lib/config', () => ({ NEXTAUTH_SECRET: 'test-secret', NEXTAUTH_URL: 'https://workon.test', SUPABASE_DOCUMENTS_BUCKET: 'documents', NODA_API_URL: 'https://noda.test', NODA_API_KEY: '' }));
vi.mock('@/lib/logger', () => ({ logSystem: vi.fn(async () => {}) }));
vi.mock('@/lib/crypto', () => ({ decryptApiKey: (s: string) => s, encryptApiKey: (s: string) => s, EncryptionKeyMissingError: class extends Error {} }));
const auth = vi.hoisted(() => ({ calls: [] as unknown[] }));
vi.mock('next-auth/react', () => ({ signOut: vi.fn(async (o: unknown) => { auth.calls.push(o); }) }));

import { configView, discover, parseSsoConfig, saveSsoConfig, ssoLogoutUrl, SSO_CONFIG_COLUMNS, SSO_DEFAULT_LABEL, type SsoConfigRow, type SsoIo, type SsoLogoutIo } from '@/lib/org-sso';
import { signOutEverywhere, ssoLogoutTarget } from '@/lib/sso-logout-client';
import { API_ROUTES } from '@/lib/api-route-ids';
import { logSystem } from '@/lib/logger';

const ISSUER = 'https://login.example.com/tenant/v2.0';
const ORG = 'org-1';
const row = (over: Partial<SsoConfigRow> = {}): SsoConfigRow => ({
  organization_id: ORG, issuer: ISSUER, client_id: 'client-1', client_secret_encrypted: 'enc', email_domains: [], enabled: true, button_label: null, updated_at: null, single_logout: true, ...over,
});
const discoveryFetch = (endSession: unknown = 'https://login.example.com/logout') => (async () => new Response(JSON.stringify({
  issuer: ISSUER, authorization_endpoint: 'https://login.example.com/a', token_endpoint: 'https://login.example.com/t', jwks_uri: 'https://login.example.com/k',
  ...(endSession === null ? {} : { end_session_endpoint: endSession }),
}))) as unknown as typeof fetch;

describe('발견 문서의 로그아웃 주소', () => {
  it('https면 담고, 없거나 https가 아니면 null — 로그인에는 영향이 없다', async () => {
    const io = (f: typeof fetch) => ({ fetch: f, publicHost: async () => true }) as unknown as SsoIo;
    expect((await discover(ISSUER, io(discoveryFetch()))).end_session_endpoint).toBe('https://login.example.com/logout');
    expect((await discover(ISSUER, io(discoveryFetch(null)))).end_session_endpoint).toBeNull();
    expect((await discover(ISSUER, io(discoveryFetch('http://login.example.com/logout')))).end_session_endpoint).toBeNull();
  });
});

describe('설정', () => {
  const base = { issuer: ISSUER, clientId: 'c' };
  it('켜진 SSO에만, 참·거짓만', () => {
    expect(parseSsoConfig({ ...base, enabled: true, singleLogout: true })).toMatchObject({ ok: true, value: { singleLogout: true } });
    expect(parseSsoConfig({ ...base, enabled: true })).toMatchObject({ ok: true, value: { singleLogout: false } });
    expect(parseSsoConfig({ ...base, enabled: false, singleLogout: true })).toMatchObject({ ok: false });
    expect(parseSsoConfig({ ...base, enabled: true, singleLogout: 'yes' })).toMatchObject({ ok: false });
  });
  const input = { issuer: ISSUER, clientId: 'client-1', clientSecret: null, emailDomains: [], enabled: true, ssoOnly: false, buttonLabel: SSO_DEFAULT_LABEL, groupClaim: null, groupMappings: [], singleLogout: true };
  const adminIo = (before: SsoConfigRow | null, f: typeof fetch, upserts: Record<string, unknown>[]) => ({
    loadConfig: async () => before, now: () => 0, encrypt: (s: string) => s, publicHost: async () => true, fetch: f,
    upsert: async (r: Record<string, unknown>) => { upserts.push(r); return { ...row(), ...r } as SsoConfigRow; },
  });
  it('계정 서비스가 로그아웃 주소를 알려 주지 않으면 켤 수 없다(저장하지 않음)', async () => {
    const upserts: Record<string, unknown>[] = [];
    expect(await saveSsoConfig(ORG, 'admin', input, adminIo(row({ single_logout: false }), discoveryFetch(null), upserts)))
      .toMatchObject({ ok: false, status: 400, message: expect.stringContaining('end_session_endpoint') });
    expect(upserts).toHaveLength(0);
  });
  it('저장하면 바뀐 칸에 남기고, SSO를 끄면 함께 꺼진다', async () => {
    const upserts: Record<string, unknown>[] = [];
    const on = await saveSsoConfig(ORG, 'admin', input, adminIo(row({ single_logout: false }), discoveryFetch(), upserts));
    expect(on).toMatchObject({ ok: true, changed: ['single_logout'], view: { singleLogout: true } });
    expect(upserts[0]).toMatchObject({ single_logout: true });
    const off = await saveSsoConfig(ORG, 'admin', { ...input, enabled: false }, adminIo(row(), discoveryFetch(), upserts));
    expect(upserts[1]).toMatchObject({ enabled: false, single_logout: false });
    expect(off).toMatchObject({ ok: true, view: { singleLogout: false } });
    expect(configView(row({ single_logout: undefined }))?.singleLogout).toBe(false);
    expect(configView(row({ enabled: false }))?.singleLogout).toBe(false);
    expect(SSO_CONFIG_COLUMNS).toContain('single_logout');
  });
});

describe('로그아웃 주소 만들기', () => {
  const io = (over: Partial<SsoLogoutIo> = {}): SsoLogoutIo => ({
    orgOfDepartment: async () => ({ id: ORG, slug: 'agency', status: 'active' }),
    loadConfig: async () => row(),
    fetch: discoveryFetch(),
    publicHost: async () => true,
    ...over,
  });
  it('켜진 기관이면 client_id와 그 기관 로그인 화면으로 돌아올 주소를 단다(id_token은 싣지 않음)', async () => {
    const url = new URL((await ssoLogoutUrl('d1', io(), 'https://workon.test'))!);
    expect(url.origin + url.pathname).toBe('https://login.example.com/logout');
    expect(Object.fromEntries(url.searchParams)).toEqual({ client_id: 'client-1', post_logout_redirect_uri: 'https://workon.test/signin/agency' });
  });
  it('함께 로그아웃 꺼짐·SSO 꺼짐·설정 없음·로그인 경로 없음·로그아웃 주소 없음이면 null', async () => {
    for (const over of [
      { loadConfig: async () => row({ single_logout: false }) },
      { loadConfig: async () => row({ single_logout: undefined }) },
      { loadConfig: async () => row({ enabled: false }) },
      { loadConfig: async () => null },
      { orgOfDepartment: async () => ({ id: ORG, slug: null, status: 'active' }) },
      { orgOfDepartment: async () => null },
      { fetch: discoveryFetch(null) },
    ] as Partial<SsoLogoutIo>[]) {
      expect(await ssoLogoutUrl('d1', io(over), 'https://workon.test')).toBeNull();
    }
  });
  it('못 읽거나 계정 서비스가 답하지 않으면 던지지 않고 null + 운영 기록(WORKON 로그아웃만 한다)', async () => {
    vi.mocked(logSystem).mockClear();
    expect(await ssoLogoutUrl('d1', io({ orgOfDepartment: async () => { throw new Error('db'); } }), 'https://workon.test')).toBeNull();
    expect(await ssoLogoutUrl('d1', io({ publicHost: async () => false }), 'https://workon.test')).toBeNull();
    expect(vi.mocked(logSystem).mock.calls.filter(([e]) => String((e as { message: string }).message).includes('logout'))).toHaveLength(2);
  });
});

describe('화면의 로그아웃', () => {
  it('https 주소만 받는다', () => {
    expect(ssoLogoutTarget({ ok: true, data: { redirect: 'https://login.example.com/logout?x=1' } })).toBe('https://login.example.com/logout?x=1');
    expect(ssoLogoutTarget({ ok: true, data: { redirect: 'javascript:alert(1)' } })).toBeNull();
    expect(ssoLogoutTarget({ ok: true, data: { redirect: null } })).toBeNull();
    expect(ssoLogoutTarget(null)).toBeNull();
  });
  it('SSO 로그인이 아니면 묻지 않고 평소처럼, 주소가 오면 WORKON 로그아웃을 마친 뒤 그리로, 못 받으면 평소처럼', async () => {
    const fetchCalls: string[] = [];
    const loc = { href: '' };
    vi.stubGlobal('window', { location: loc });
    const reply = (body: unknown, status = 200) => vi.stubGlobal('fetch', vi.fn(async (u: string) => { fetchCalls.push(u); return new Response(JSON.stringify(body), { status }); }));

    auth.calls.length = 0; reply({ ok: true, data: { redirect: 'https://login.example.com/logout' } });
    await signOutEverywhere('/login', false);
    expect(fetchCalls).toHaveLength(0);
    expect(auth.calls).toEqual([{ callbackUrl: '/login' }]);

    auth.calls.length = 0;
    await signOutEverywhere('/login', true);
    expect(fetchCalls).toEqual(['/api/sso/logout']);
    expect(auth.calls).toEqual([{ redirect: false }]);
    expect(loc.href).toBe('https://login.example.com/logout');

    auth.calls.length = 0; loc.href = '';
    reply({ ok: false, error: { message: 'x' } }, 500);
    await signOutEverywhere('/login', true);
    expect(auth.calls).toEqual([{ callbackUrl: '/login' }]);
    expect(loc.href).toBe('');
    vi.unstubAllGlobals();
  });
  it('로그아웃 단추 셋이 이 길로 간다·세션에 SSO 표시·라우트 등록', () => {
    for (const f of ['src/components/layout/UserMenu.tsx', 'src/components/chat/ChatHome.tsx', 'src/components/Navigation.tsx']) {
      const src = readFileSync(f, 'utf8');
      expect(src).toContain('signOutEverywhere(');
      expect(src).not.toMatch(/\bsignOut\(\{ callbackUrl/);
    }
    expect(readFileSync('src/lib/nextAuthOptions.ts', 'utf8')).toContain('if (token.sso === true) session.user.sso = true;');
    const route = readFileSync('src/app/api/sso/logout/route.ts', 'utf8');
    expect(route).toContain('export async function POST');
    expect(route).toContain("session.user.sso !== true || session.user.isImpersonating");
    expect(API_ROUTES).toContain('sso/logout');
  });
});

const dbUrl = process.env.WORK_TEST_DATABASE_URL;
describe.skipIf(!dbUrl)('0111 — 함께 로그아웃 칸(시험 DB)', () => {
  let db: pg.Client;
  beforeAll(async () => {
    if (/supabase\.(co|com)|pooler\./.test(dbUrl!)) throw new Error('운영 DB 주소로 보입니다 — 시험 DB를 쓰세요');
    db = new pg.Client({ connectionString: dbUrl });
    await db.connect();
  });
  afterAll(async () => { await db?.end(); });
  it('여러 번 적용해도 안전·꺼진 SSO에는 걸 수 없음', async () => {
    expect(existsSync('supabase/migrations/0111_org_sso_single_logout.sql')).toBe(true);
    await db.query('BEGIN');
    try {
      const sql = readFileSync('supabase/migrations/0111_org_sso_single_logout.sql', 'utf8');
      await db.query(sql); await db.query(sql);
      const orgId = randomUUID();
      await db.query('INSERT INTO organizations (id, name) VALUES ($1, $2)', [orgId, '0111 기관']);
      await db.query("INSERT INTO org_sso_providers (organization_id, issuer, client_id, client_secret_encrypted, enabled, single_logout) VALUES ($1, 'https://login.example.com', 'c', 'enc', true, true)", [orgId]);
      await db.query('SAVEPOINT s');
      await expect(db.query('UPDATE org_sso_providers SET enabled = false WHERE organization_id = $1', [orgId])).rejects.toThrow(/check/i);
      await db.query('ROLLBACK TO SAVEPOINT s');
      await db.query('UPDATE org_sso_providers SET enabled = false, single_logout = false WHERE organization_id = $1', [orgId]);
    } finally {
      await db.query('ROLLBACK');
    }
  });
});
