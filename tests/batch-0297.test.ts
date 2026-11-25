import { readFileSync } from 'fs';
import { createSign, generateKeyPairSync, randomUUID } from 'crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import pg from 'pg';

/**
 * 2026-11-25 — 기관 SSO 그룹 → 관리자 역할(0115). 기관 계정으로 로그인할 때 그룹 클레임에 '관리자로 들일 그룹'이 든 일반 직원을
 * 관리자로 올리고, 이 길로 올린 관리자가 그룹에서 빠지면 내린다. 손으로 지정한 관리자는 건드리지 않는다.
 */

const db = vi.hoisted(() => ({
  calls: [] as { table: string; ops: [string, unknown[]][] }[],
  respond: (_table: string, _ops: [string, unknown[]][]): { data: unknown; error: unknown } => ({ data: null, error: null }),
}));
vi.mock('@/lib/supabaseAdmin', () => {
  const builder = (table: string) => {
    const ops: [string, unknown[]][] = [];
    db.calls.push({ table, ops });
    const b: Record<string, unknown> = {};
    for (const op of ['select', 'in', 'eq', 'is', 'update', 'order', 'range', 'maybeSingle', 'single', 'upsert', 'ilike', 'limit']) {
      b[op] = (...args: unknown[]) => { ops.push([op, args]); return b; };
    }
    b.then = (ok: (v: unknown) => unknown, bad: (e: unknown) => unknown) => Promise.resolve(db.respond(table, ops)).then(ok, bad);
    return b;
  };
  return { supabaseAdmin: { from: (t: string) => builder(t) } };
});
vi.mock('@/lib/config', () => ({ NEXTAUTH_SECRET: 'test-secret', NEXTAUTH_URL: 'https://workon.test', SUPABASE_DOCUMENTS_BUCKET: 'documents', NODA_API_URL: 'https://noda.test', NODA_API_KEY: '' }));
vi.mock('@/lib/logger', () => ({ logSystem: vi.fn(async () => {}) }));
vi.mock('@/lib/crypto', () => ({ decryptApiKey: (s: string) => s.replace(/^enc:/, ''), encryptApiKey: (s: string) => `enc:${s}`, EncryptionKeyMissingError: class extends Error {} }));
const security = vi.hoisted(() => ({ events: [] as unknown[][] }));
vi.mock('@/lib/security-log', () => ({ logSecurityEvent: vi.fn(async (...a: unknown[]) => { security.events.push(a); return true; }) }));

import {
  adminGroupMatch, configView, defaultSsoIo, finishSso, parseAdminGroups, parseSsoConfig, readAdminGroups, saveSsoConfig, startSso,
  SSO_CONFIG_COLUMNS, SSO_DEFAULT_LABEL, SSO_MAX_ADMIN_GROUPS, type SsoConfigRow, type SsoIo, type SsoUserRow,
} from '@/lib/org-sso';
import { SECURITY_EVENT_LABELS } from '@/lib/security-event-text';
import { logSystem } from '@/lib/logger';

const D1 = '11111111-1111-4111-8111-111111111111';
const D2 = '22222222-2222-4222-8222-222222222222';
const ISSUER = 'https://login.example.com/tenant/v2.0';
const CLIENT = 'client-123';
const ORG = 'org-1';
const NOW = Date.parse('2026-11-25T03:00:00Z');
const APP = 'https://workon.test';
const SECRET = 'test-secret';

describe('관리자 그룹 고르기·검사', () => {
  it('클레임 값에 든 관리자 그룹 — 대소문자·앞뒤 공백을 가리지 않고, 클레임·목록이 없으면 null', () => {
    expect(adminGroupMatch({ groups: ['직원', 'WORKON-Admins'] }, 'groups', ['workon-admins'])).toBe('workon-admins');
    expect(adminGroupMatch({ realm_access: { roles: ['admin'] } }, 'realm_access.roles', ['admin'])).toBe('admin');
    expect(adminGroupMatch({ groups: ['직원'] }, 'groups', ['workon-admins'])).toBeNull();
    expect(adminGroupMatch({ groups: ['workon-admins'] }, null, ['workon-admins'])).toBeNull();
    expect(adminGroupMatch({ groups: ['workon-admins'] }, 'groups', [])).toBeNull();
  });
  it('입력 — 줄 나눈 글이나 목록, 빈 줄·겹침은 빼고, 20개·200자·클레임 필요', () => {
    expect(parseAdminGroups('a\n\n b \nA', 'groups')).toEqual({ ok: true, groups: ['a', 'b'] });
    expect(parseAdminGroups(['x', 'y'], 'groups')).toEqual({ ok: true, groups: ['x', 'y'] });
    expect(parseAdminGroups(undefined, null)).toEqual({ ok: true, groups: [] });
    expect(parseAdminGroups('', null)).toEqual({ ok: true, groups: [] });
    expect(parseAdminGroups(['a'], null)).toMatchObject({ ok: false, message: expect.stringContaining('클레임') });
    expect(parseAdminGroups(['x'.repeat(201)], 'g')).toMatchObject({ ok: false });
    expect(parseAdminGroups(Array.from({ length: SSO_MAX_ADMIN_GROUPS + 1 }, (_, i) => `g${i}`), 'g')).toMatchObject({ ok: false });
    expect(parseAdminGroups([{}], 'g')).toMatchObject({ ok: false });
    expect(parseAdminGroups(5, 'g')).toMatchObject({ ok: false });
  });
  it('저장 요청 검사가 함께 본다, 저장된 값 읽기는 글만', () => {
    expect(parseSsoConfig({ issuer: ISSUER, clientId: 'c', groupClaim: 'groups', adminGroups: 'workon-admins' })).toMatchObject({ ok: true, value: { adminGroups: ['workon-admins'] } });
    expect(parseSsoConfig({ issuer: ISSUER, clientId: 'c', adminGroups: ['workon-admins'] })).toMatchObject({ ok: false });
    expect(parseSsoConfig({ issuer: ISSUER, clientId: 'c' })).toMatchObject({ ok: true, value: { adminGroups: [] } });
    expect(readAdminGroups(['a', '', 3, null])).toEqual(['a', '3']);
    expect(readAdminGroups(undefined)).toEqual([]);
  });
});

describe('설정 저장·보기', () => {
  const row = (over: Partial<SsoConfigRow> = {}): SsoConfigRow => ({ organization_id: ORG, issuer: ISSUER, client_id: 'c', client_secret_encrypted: 'enc', email_domains: [], enabled: false, button_label: null, updated_at: null, group_claim: 'groups', ...over });
  const input = { issuer: ISSUER, clientId: 'c', clientSecret: null, emailDomains: [], enabled: false, ssoOnly: false, buttonLabel: SSO_DEFAULT_LABEL, groupClaim: 'groups', groupMappings: [], adminGroups: ['workon-admins'], singleLogout: false };
  const io = (before: SsoConfigRow | null, upserts: Record<string, unknown>[]) => ({
    loadConfig: async () => before, now: () => 0, encrypt: (s: string) => s, publicHost: async () => true, fetch,
    upsert: async (r: Record<string, unknown>) => { upserts.push(r); return { ...row(), ...r } as SsoConfigRow; },
  });
  it('저장하고 바뀐 칸에 남긴다, 같은 값이면 남기지 않는다, 옛 행은 빈 목록', async () => {
    const upserts: Record<string, unknown>[] = [];
    expect(await saveSsoConfig(ORG, 'admin', input, io(row(), upserts))).toMatchObject({ ok: true, changed: ['admin_groups'], view: { adminGroups: ['workon-admins'] } });
    expect(upserts[0]).toMatchObject({ admin_groups: ['workon-admins'] });
    expect(await saveSsoConfig(ORG, 'admin', input, io(row({ admin_groups: ['workon-admins'] }), []))).toMatchObject({ ok: true, changed: [] });
    expect(configView(row())).toMatchObject({ adminGroups: [] });
    expect(SSO_CONFIG_COLUMNS).toContain('admin_groups');
  });
});

// ── 로그인 흐름(가짜 계정 서비스) ──
const rsa = generateKeyPairSync('rsa', { modulusLength: 2048 });
const keys = [{ ...(rsa.publicKey.export({ format: 'jwk' }) as Record<string, unknown>), kid: 'k1', use: 'sig', alg: 'RS256' }];
const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url');
const jwt = (claims: Record<string, unknown>) => {
  const head = `${b64({ alg: 'RS256', kid: 'k1' })}.${b64(claims)}`;
  return `${head}.${createSign('RSA-SHA256').update(head).sign(rsa.privateKey).toString('base64url')}`;
};
const config = (over: Partial<SsoConfigRow> = {}): SsoConfigRow => ({
  organization_id: ORG, issuer: ISSUER, client_id: CLIENT, client_secret_encrypted: 'enc:shh', email_domains: [], enabled: true, button_label: null, updated_at: null,
  group_claim: 'groups', group_mappings: [], admin_groups: ['workon-admins'], ...over,
});
const user = (over: Partial<SsoUserRow> = {}): SsoUserRow => ({
  id: 'u1', email: 'kim@agency.go.kr', full_name: '김주무관', role: 'USER', department_id: D1, is_active: true, deleted_at: null, is_super_admin: false, role_from_sso: false, ...over,
});
let lastNonce = '';
function fakeIo(over: Partial<SsoIo> & { groups?: unknown } = {}) {
  const calls = { mint: [] as { role: string; departmentId: string }[], record: [] as unknown[][], role: [] as unknown[], dept: [] as unknown[] };
  let rand = 0;
  const io: SsoIo = {
    loadOrgBySlug: async (slug) => ({ id: ORG, slug, status: 'active' }),
    loadConfig: async () => config(),
    decrypt: (s) => s.replace(/^enc:/, ''),
    fetch: (async (input: string) => {
      const url = String(input);
      if (url.endsWith('/.well-known/openid-configuration')) return new Response(JSON.stringify({ issuer: ISSUER, authorization_endpoint: 'https://login.example.com/authorize', token_endpoint: 'https://login.example.com/token', jwks_uri: 'https://login.example.com/keys' }));
      if (url.endsWith('/token')) return new Response(JSON.stringify({ id_token: jwt({ iss: ISSUER, aud: CLIENT, exp: NOW / 1000 + 600, iat: NOW / 1000, nonce: lastNonce, email: 'kim@agency.go.kr', sub: 's1', groups: 'groups' in over ? over.groups : ['직원', 'workon-admins'] }) }));
      return new Response(JSON.stringify({ keys }));
    }) as unknown as typeof fetch,
    publicHost: async () => true,
    findUser: async () => user(),
    lockIfDormant: async () => false,
    record: async (...a) => { calls.record.push(a); },
    mintSession: async (u) => { calls.mint.push(u); return 'SESSION'; },
    now: () => NOW,
    random: (n) => Buffer.alloc(n, ++rand),
    syncRole: async (a) => { calls.role.push(a); return true; },
    syncDepartment: async (a) => { calls.dept.push(a); return true; },
    ...over,
  };
  return { io, calls };
}
async function login(io: SsoIo) {
  const started = await startSso('agency', io, APP, SECRET);
  const auth = new URL(started.redirect);
  lastNonce = auth.searchParams.get('nonce')!;
  return finishSso(new URLSearchParams({ code: 'C', state: auth.searchParams.get('state')! }), started.stateCookie, io, APP, SECRET);
}

describe('로그인 때 관리자 역할 맞추기', () => {
  it('관리자 그룹에 든 일반 직원은 관리자로 올리고 관리자 세션을 만든다', async () => {
    const { io, calls } = fakeIo();
    expect(await login(io)).toEqual({ redirect: '/', session: 'SESSION' });
    expect(calls.role).toEqual([{ userId: 'u1', organizationId: ORG, departmentId: D1, to: 'ADMIN', group: 'workon-admins' }]);
    expect(calls.mint[0]).toMatchObject({ role: 'ADMIN', departmentId: D1 });
  });
  it('부서도 맞추면 옮긴 부서에서 관리자로', async () => {
    const { io, calls } = fakeIo({ loadConfig: async () => config({ group_mappings: [{ value: '직원', departmentId: D2 }] }) });
    await login(io);
    expect(calls.dept).toHaveLength(1);
    expect(calls.role[0]).toMatchObject({ departmentId: D2, to: 'ADMIN' });
    expect(calls.mint[0]).toMatchObject({ role: 'ADMIN', departmentId: D2 });
  });
  it('이 길로 올린 관리자가 그룹에서 빠지면 일반 직원으로 내리고, 그다음 부서 맞추기도 받는다', async () => {
    const { io, calls } = fakeIo({
      groups: ['직원'], findUser: async () => user({ role: 'ADMIN', role_from_sso: true }),
      loadConfig: async () => config({ group_mappings: [{ value: '직원', departmentId: D2 }] }),
    });
    expect(await login(io)).toEqual({ redirect: '/', session: 'SESSION' });
    expect(calls.role).toEqual([{ userId: 'u1', organizationId: ORG, departmentId: D1, to: 'USER', group: null }]);
    expect(calls.dept).toHaveLength(1);
    expect(calls.mint[0]).toMatchObject({ role: 'USER', departmentId: D2 });
  });
  it('손으로 지정한 관리자·그룹에 그대로 있는 관리자·목록 없음·클레임 없음은 건드리지 않는다', async () => {
    const cases: (Partial<SsoIo> & { groups?: unknown })[] = [
      { groups: ['직원'], findUser: async () => user({ role: 'ADMIN', role_from_sso: false }) },
      { findUser: async () => user({ role: 'ADMIN', role_from_sso: true }) },
      { loadConfig: async () => config({ admin_groups: [] }) },
      { loadConfig: async () => config({ admin_groups: undefined }) },
      { groups: ['직원'], findUser: async () => user({ role: 'ADMIN', role_from_sso: true }), loadConfig: async () => config({ admin_groups: [] }) },
      { groups: ['직원'] },
    ];
    for (const over of cases) {
      const { io, calls } = fakeIo(over);
      expect(await login(io)).toEqual({ redirect: '/', session: 'SESSION' });
      expect(calls.role).toHaveLength(0);
    }
  });
  it('올리지 못하면(던짐·그 사이 바뀜) 일반 직원으로 들어온다', async () => {
    vi.mocked(logSystem).mockClear();
    const thrown = fakeIo({ syncRole: async () => { throw new Error('db'); } });
    expect(await login(thrown.io)).toEqual({ redirect: '/', session: 'SESSION' });
    expect(thrown.calls.mint[0].role).toBe('USER');
    expect(vi.mocked(logSystem).mock.calls.some(([e]) => String((e as { message: string }).message).includes('role_sync'))).toBe(true);
    const raced = fakeIo({ syncRole: async () => false });
    await login(raced.io);
    expect(raced.calls.mint[0].role).toBe('USER');
  });
  it('내려야 할 관리자를 못 내리면(던짐·그 사이 바뀜·기능 없음) 들이지 않는다 — 관리자 세션을 만들지 않음', async () => {
    const admin = { groups: ['직원'], findUser: async () => user({ role: 'ADMIN', role_from_sso: true }) };
    for (const syncRole of [async () => { throw new Error('db'); }, async () => false, undefined]) {
      const { io, calls } = fakeIo({ ...admin, syncRole });
      const r = await login(io);
      expect(r.session).toBeUndefined();
      expect(r.redirect).toContain('error=sso_unavailable');
      expect(calls.mint).toHaveLength(0);
      expect(calls.record.at(-1)?.[0]).toBe('login_rejected');
    }
  });
});

describe('기본 syncRole(DB)', () => {
  const run = (to: 'ADMIN' | 'USER') => defaultSsoIo().syncRole!({ userId: 'u1', organizationId: ORG, departmentId: D1, to, group: to === 'ADMIN' ? 'workon-admins' : null });
  it('올리기는 일반 직원만 조건부로·표시 참, 보안 로그 high', async () => {
    db.calls.length = 0; security.events.length = 0;
    db.respond = () => ({ data: [{ id: 'u1' }], error: null });
    expect(await run('ADMIN')).toBe(true);
    const ops = db.calls.find((c) => c.table === 'users')!.ops;
    expect(ops).toEqual(expect.arrayContaining([
      ['update', [{ role: 'ADMIN', role_from_sso: true }]], ['eq', ['id', 'u1']], ['eq', ['department_id', D1]], ['eq', ['role', 'USER']],
      ['is', ['deleted_at', null]], ['eq', ['is_active', true]], ['eq', ['is_super_admin', false]],
    ]));
    expect(security.events[0]).toEqual([D1, 'u1', 'user_role_synced', expect.objectContaining({ target_user_id: 'u1', from_role: 'USER', to_role: 'ADMIN', via: 'sso_group', sso_group: 'workon-admins' }), 'high']);
  });
  it('내리기는 이 길로 올린 관리자만·표시 거짓', async () => {
    db.calls.length = 0; security.events.length = 0;
    db.respond = () => ({ data: [{ id: 'u1' }], error: null });
    expect(await run('USER')).toBe(true);
    const ops = db.calls.find((c) => c.table === 'users')!.ops;
    expect(ops).toEqual(expect.arrayContaining([['update', [{ role: 'USER', role_from_sso: false }]], ['eq', ['role', 'ADMIN']], ['eq', ['role_from_sso', true]]]));
    expect(security.events[0]?.[3]).toMatchObject({ from_role: 'ADMIN', to_role: 'USER' });
    expect(security.events[0]?.[3]).not.toHaveProperty('sso_group');
  });
  it('바뀐 줄이 없으면 false·기록 없음, 쓰기 실패는 던진다', async () => {
    security.events.length = 0;
    db.respond = () => ({ data: [], error: null });
    expect(await run('ADMIN')).toBe(false);
    expect(security.events).toHaveLength(0);
    db.respond = () => ({ data: null, error: { code: 'XX' } });
    await expect(run('USER')).rejects.toThrow();
  });
  it('직원 찾기가 role_from_sso를 읽는다', () => {
    expect(readFileSync('src/lib/org-sso.ts', 'utf8')).toContain("is_super_admin, role_from_sso')");
  });
});

describe('잇기', () => {
  it('손으로 권한을 바꾸면 SSO 표시를 지운다(기관 관리자·슈퍼관리자)', () => {
    expect(readFileSync('src/app/api/users/[id]/route.ts', 'utf8')).toMatch(/update\.role = role;\s*\/\/[^\n]*\n\s*update\.role_from_sso = false;/);
    expect(readFileSync('src/app/api/super/accounts/users/[id]/route.ts', 'utf8')).toMatch(/update\.role = body\.role;\s*update\.role_from_sso = false;/);
  });
  it('감사 이름표·보안 로그·설정 화면', () => {
    expect(SECURITY_EVENT_LABELS.user_role_synced).toBe('관리자 권한 맞추기(기관 SSO 그룹)');
    expect(readFileSync('src/app/api/admin/sso/route.ts', 'utf8')).toContain('admin_groups: saved.view.adminGroups.length');
    const panel = readFileSync('src/components/admin/OrgSsoPanel.tsx', 'utf8');
    expect(panel).toContain('groupClaim, groupMappings: mappings, adminGroups }');
    expect(panel).toContain("setAdminGroups((c?.adminGroups ?? []).join('\\n'))");
  });
});

const dbUrl = process.env.WORK_TEST_DATABASE_URL;
describe.skipIf(!dbUrl)('0115 — 관리자 그룹 칸(시험 DB)', () => {
  let pgdb: pg.Client;
  beforeAll(async () => {
    if (/supabase\.(co|com)|pooler\./.test(dbUrl!)) throw new Error('운영 DB 주소로 보입니다 — 시험 DB를 쓰세요');
    pgdb = new pg.Client({ connectionString: dbUrl });
    await pgdb.connect();
  });
  afterAll(async () => { await pgdb?.end(); });
  it('여러 번 적용해도 안전·목록은 클레임과 함께·20개까지·users.role_from_sso 기본 거짓', async () => {
    await pgdb.query('BEGIN');
    try {
      const sql = readFileSync('supabase/migrations/0115_org_sso_admin_groups.sql', 'utf8');
      await pgdb.query(sql); await pgdb.query(sql);
      const orgId = randomUUID();
      await pgdb.query('INSERT INTO organizations (id, name) VALUES ($1, $2)', [orgId, '0115 기관']);
      await pgdb.query("INSERT INTO org_sso_providers (organization_id, issuer, client_id) VALUES ($1, 'https://login.example.com', 'c')", [orgId]);
      expect((await pgdb.query('SELECT admin_groups FROM org_sso_providers WHERE organization_id = $1', [orgId])).rows).toEqual([{ admin_groups: [] }]);
      await pgdb.query('SAVEPOINT s');
      await expect(pgdb.query("UPDATE org_sso_providers SET admin_groups = ARRAY['a'] WHERE organization_id = $1", [orgId])).rejects.toThrow(/check/i);
      await pgdb.query('ROLLBACK TO SAVEPOINT s');
      await pgdb.query("UPDATE org_sso_providers SET group_claim = 'groups', admin_groups = ARRAY['a'] WHERE organization_id = $1", [orgId]);
      await pgdb.query('SAVEPOINT t');
      await expect(pgdb.query('UPDATE org_sso_providers SET admin_groups = $2 WHERE organization_id = $1', [orgId, Array.from({ length: 21 }, (_, i) => `g${i}`)])).rejects.toThrow(/check/i);
      await pgdb.query('ROLLBACK TO SAVEPOINT t');
      const col = await pgdb.query("SELECT data_type, is_nullable, column_default FROM information_schema.columns WHERE table_name = 'users' AND column_name = 'role_from_sso'");
      expect(col.rows[0]).toMatchObject({ data_type: 'boolean', is_nullable: 'NO', column_default: 'false' });
    } finally {
      await pgdb.query('ROLLBACK');
    }
  });
});
