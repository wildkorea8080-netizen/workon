import { readFileSync, existsSync } from 'fs';
import { createSign, generateKeyPairSync, randomUUID } from 'crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import pg from 'pg';

/**
 * 2026-11-25 — 기관 SSO 그룹 → 부서 맞추기(0110). 기관 계정으로 로그인할 때 id_token의 클레임(예: groups) 값 중
 * 목록에서 처음 맞는 부서로 **일반 직원**의 소속을 옮긴다. 관리자는 그대로, 맞는 값이 없거나 옮기지 못하면 소속 그대로 들어온다.
 */

// 기본 syncDepartment가 쓰는 DB를 가짜로 — 표마다 돌려줄 값과 걸린 조건을 기록한다
const db = vi.hoisted(() => ({
  calls: [] as { table: string; ops: [string, unknown[]][] }[],
  respond: (_table: string, _ops: [string, unknown[]][]): { data: unknown; error: unknown } => ({ data: null, error: null }),
}));
vi.mock('@/lib/supabaseAdmin', () => {
  const builder = (table: string) => {
    const ops: [string, unknown[]][] = [];
    const call = { table, ops };
    db.calls.push(call);
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
  claimValues, configView, defaultSsoIo, finishSso, groupDepartment, parseGroupMapping, parseSsoConfig, readGroupMappings, saveSsoConfig, startSso,
  SSO_CONFIG_COLUMNS, SSO_DEFAULT_LABEL, SSO_MAX_GROUP_MAPPINGS, type SsoConfigRow, type SsoIo, type SsoUserRow,
} from '@/lib/org-sso';
import { SECURITY_EVENT_LABELS, securityDetailParts } from '@/lib/security-event-text';
import { logSystem } from '@/lib/logger';

const D1 = '11111111-1111-4111-8111-111111111111';
const D2 = '22222222-2222-4222-8222-222222222222';
const D3 = '33333333-3333-4333-8333-333333333333';
const ISSUER = 'https://login.example.com/tenant/v2.0';
const CLIENT = 'client-123';
const ORG = 'org-1';
const NOW = Date.parse('2026-11-25T03:00:00Z');
const APP = 'https://workon.test';
const SECRET = 'test-secret';

describe('그룹 값 읽기·고르기', () => {
  it('클레임 이름 그대로 먼저, 없으면 점으로 내려간다 — 글·숫자·그 배열만', () => {
    expect(claimValues({ groups: ['총무과', ' 기획팀 ', 7, null, {}] }, 'groups')).toEqual(['총무과', '기획팀', '7']);
    expect(claimValues({ department: '총무과' }, 'department')).toEqual(['총무과']);
    expect(claimValues({ realm_access: { roles: ['a', 'b'] } }, 'realm_access.roles')).toEqual(['a', 'b']);
    expect(claimValues({ 'https://x.example/groups': ['g'] }, 'https://x.example/groups')).toEqual(['g']);
    expect(claimValues({}, 'groups')).toEqual([]);
  });
  it('목록을 위에서부터 보아 처음 맞는 부서 — 대소문자·앞뒤 공백·보이지 않는 글자는 가리지 않는다', () => {
    const mappings = [{ value: 'HQ-General', departmentId: D1 }, { value: '기획팀', departmentId: D2 }];
    expect(groupDepartment({ groups: ['기획팀', 'hq-general'] }, 'groups', mappings)).toEqual({ value: 'HQ-General', departmentId: D1 });
    expect(groupDepartment({ groups: ['기​획팀'] }, 'groups', mappings)).toEqual({ value: '기획팀', departmentId: D2 });
    expect(groupDepartment({ groups: ['다른 팀'] }, 'groups', mappings)).toBeNull();
    expect(groupDepartment({ groups: ['기획팀'] }, null, mappings)).toBeNull();
    expect(groupDepartment({ groups: ['기획팀'] }, 'groups', [])).toBeNull();
  });
  it('저장된 목록 읽기는 꼴이 틀린 줄을 버린다', () => {
    expect(readGroupMappings([{ value: 'a', departmentId: D1.toUpperCase() }, { value: '', departmentId: D2 }, { value: 'b', departmentId: 'x' }, 'z', null])).toEqual([{ value: 'a', departmentId: D1 }]);
    expect(readGroupMappings(undefined)).toEqual([]);
    expect(readGroupMappings({})).toEqual([]);
  });
});

describe('설정 검사', () => {
  it('클레임은 비우면 끔, 목록이 있으면 클레임이 있어야 한다', () => {
    expect(parseGroupMapping('', [])).toEqual({ ok: true, claim: null, mappings: [] });
    expect(parseGroupMapping(undefined, undefined)).toEqual({ ok: true, claim: null, mappings: [] });
    expect(parseGroupMapping(' groups ', [{ value: ' 총무과 ', departmentId: D1 }])).toEqual({ ok: true, claim: 'groups', mappings: [{ value: '총무과', departmentId: D1 }] });
    expect(parseGroupMapping('', [{ value: '총무과', departmentId: D1 }])).toMatchObject({ ok: false, message: expect.stringContaining('클레임 이름') });
  });
  it('클레임 꼴·줄 꼴·겹치는 값·상한을 거절한다', () => {
    expect(parseGroupMapping('groups; drop', [])).toMatchObject({ ok: false });
    expect(parseGroupMapping(5, [])).toMatchObject({ ok: false });
    expect(parseGroupMapping('g', 'x')).toMatchObject({ ok: false });
    expect(parseGroupMapping('g', [{ value: '', departmentId: D1 }])).toMatchObject({ ok: false, message: expect.stringContaining('1째 줄') });
    expect(parseGroupMapping('g', [{ value: 'a', departmentId: 'nope' }])).toMatchObject({ ok: false, message: expect.stringContaining('부서를 골라') });
    expect(parseGroupMapping('g', [{ value: 'A', departmentId: D1 }, { value: 'a', departmentId: D2 }])).toMatchObject({ ok: false, message: expect.stringContaining('두 번') });
    expect(parseGroupMapping('g', [{ value: 'x'.repeat(201), departmentId: D1 }])).toMatchObject({ ok: false });
    const many = Array.from({ length: SSO_MAX_GROUP_MAPPINGS + 1 }, (_, i) => ({ value: `g${i}`, departmentId: D1 }));
    expect(parseGroupMapping('g', many)).toMatchObject({ ok: false });
  });
  it('저장 요청 검사가 그룹 칸을 함께 본다', () => {
    const base = { issuer: ISSUER, clientId: 'c' };
    expect(parseSsoConfig({ ...base, groupClaim: 'groups', groupMappings: [{ value: 'a', departmentId: D1 }] }))
      .toMatchObject({ ok: true, value: { groupClaim: 'groups', groupMappings: [{ value: 'a', departmentId: D1 }] } });
    expect(parseSsoConfig({ ...base, groupMappings: [{ value: 'a', departmentId: D1 }] })).toMatchObject({ ok: false });
  });
});

describe('설정 저장·보기', () => {
  const row = (over: Partial<SsoConfigRow> = {}): SsoConfigRow => ({ organization_id: ORG, issuer: ISSUER, client_id: 'c', client_secret_encrypted: 'enc', email_domains: [], enabled: false, button_label: null, updated_at: null, ...over });
  const io = (before: SsoConfigRow | null, upserts: Record<string, unknown>[]) => ({
    loadConfig: async () => before, now: () => 0, encrypt: (s: string) => s, publicHost: async () => true, fetch: fetch,
    upsert: async (r: Record<string, unknown>) => { upserts.push(r); return { ...row(), ...r } as SsoConfigRow; },
  });
  const input = { issuer: ISSUER, clientId: 'c', clientSecret: null, emailDomains: [], enabled: false, ssoOnly: false, buttonLabel: SSO_DEFAULT_LABEL, groupClaim: 'groups', groupMappings: [{ value: '총무과', departmentId: D1 }], adminGroups: [], singleLogout: false };
  it('그룹 칸을 저장하고 바뀐 칸에 남긴다, 같은 값이면 남기지 않는다', async () => {
    const upserts: Record<string, unknown>[] = [];
    const r = await saveSsoConfig(ORG, 'admin', input, io(row(), upserts));
    expect(upserts[0]).toMatchObject({ group_claim: 'groups', group_mappings: [{ value: '총무과', departmentId: D1 }] });
    expect(r).toMatchObject({ ok: true, changed: ['group_claim', 'group_mappings'], view: { groupClaim: 'groups', groupMappings: [{ value: '총무과', departmentId: D1 }] } });
    const again = await saveSsoConfig(ORG, 'admin', input, io(row({ group_claim: 'groups', group_mappings: [{ value: '총무과', departmentId: D1 }] }), []));
    expect(again).toMatchObject({ ok: true, changed: [] });
  });
  it('칸이 없던 옛 행은 맞추지 않음으로 보인다, 설정 select에 두 칸이 있다', () => {
    expect(configView(row())).toMatchObject({ groupClaim: null, groupMappings: [] });
    expect(SSO_CONFIG_COLUMNS).toContain('group_claim');
    expect(SSO_CONFIG_COLUMNS).toContain('group_mappings');
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
  group_claim: 'groups', group_mappings: [{ value: '기획팀', departmentId: D2 }, { value: '총무과', departmentId: D1 }], ...over,
});
const user = (over: Partial<SsoUserRow> = {}): SsoUserRow => ({
  id: 'u1', email: 'kim@agency.go.kr', full_name: '김주무관', role: 'USER', department_id: D1, is_active: true, deleted_at: null, is_super_admin: false, ...over,
});
let lastNonce = '';
function fakeIo(over: Partial<SsoIo> & { groups?: unknown } = {}) {
  const calls = { mint: [] as { departmentId: string }[], record: [] as unknown[][], sync: [] as unknown[] };
  let rand = 0;
  const io: SsoIo = {
    loadOrgBySlug: async (slug) => ({ id: ORG, slug, status: 'active' }),
    loadConfig: async () => config(),
    decrypt: (s) => s.replace(/^enc:/, ''),
    fetch: (async (input: string) => {
      const url = String(input);
      if (url.endsWith('/.well-known/openid-configuration')) return new Response(JSON.stringify({ issuer: ISSUER, authorization_endpoint: 'https://login.example.com/authorize', token_endpoint: 'https://login.example.com/token', jwks_uri: 'https://login.example.com/keys' }));
      if (url.endsWith('/token')) return new Response(JSON.stringify({ id_token: jwt({ iss: ISSUER, aud: CLIENT, exp: NOW / 1000 + 600, iat: NOW / 1000, nonce: lastNonce, email: 'kim@agency.go.kr', groups: 'groups' in over ? over.groups : ['직원', '기획팀'] }) }));
      return new Response(JSON.stringify({ keys }));
    }) as unknown as typeof fetch,
    publicHost: async () => true,
    findUser: async () => user(),
    lockIfDormant: async () => false,
    record: async (...a) => { calls.record.push(a); },
    mintSession: async (u) => { calls.mint.push(u); return 'SESSION'; },
    now: () => NOW,
    random: (n) => Buffer.alloc(n, ++rand),
    syncDepartment: async (a) => { calls.sync.push(a); return true; },
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

describe('로그인 때 부서 맞추기', () => {
  it('일반 직원은 목록에서 처음 맞는 그룹의 부서로 옮기고, 그 부서로 세션·접속 기록을 만든다', async () => {
    const { io, calls } = fakeIo();
    expect(await login(io)).toEqual({ redirect: '/', session: 'SESSION' });
    expect(calls.sync).toEqual([{ userId: 'u1', organizationId: ORG, from: D1, to: D2, group: '기획팀' }]);
    expect(calls.mint[0].departmentId).toBe(D2);
    expect(calls.record.at(-1)).toEqual(['login', 'kim@agency.go.kr', { id: 'u1', departmentId: D2 }]);
  });
  it('이미 그 부서·맞는 그룹 없음·클레임 없음·목록 없음·관리자는 옮기지 않는다', async () => {
    const cases: Partial<SsoIo & { groups: unknown }>[] = [
      { findUser: async () => user({ department_id: D2 }) },
      { groups: ['다른 팀'] },
      { groups: undefined },
      { loadConfig: async () => config({ group_claim: null, group_mappings: [] }) },
      { loadConfig: async () => config({ group_claim: undefined, group_mappings: undefined }) },
      { findUser: async () => user({ role: 'ADMIN' }) },
    ];
    for (const over of cases) {
      const { io, calls } = fakeIo(over);
      expect(await login(io)).toEqual({ redirect: '/', session: 'SESSION' });
      expect(calls.sync).toHaveLength(0);
      expect(calls.mint[0].departmentId).toBe(over.findUser ? (await over.findUser('', ORG))!.department_id : D1);
    }
  });
  it('옮기지 못하면(던짐·그 사이 바뀜) 소속 그대로 들어오고, 던진 것은 운영 기록에 남는다', async () => {
    vi.mocked(logSystem).mockClear();
    const thrown = fakeIo({ syncDepartment: async () => { throw new Error('db'); } });
    expect(await login(thrown.io)).toEqual({ redirect: '/', session: 'SESSION' });
    expect(thrown.calls.mint[0].departmentId).toBe(D1);
    expect(vi.mocked(logSystem).mock.calls.some(([e]) => String((e as { message: string }).message).includes('group_sync'))).toBe(true);
    const raced = fakeIo({ syncDepartment: async () => false });
    expect(await login(raced.io)).toEqual({ redirect: '/', session: 'SESSION' });
    expect(raced.calls.mint[0].departmentId).toBe(D1);
  });
});

describe('기본 syncDepartment(DB)', () => {
  const run = () => defaultSsoIo().syncDepartment!({ userId: 'u1', organizationId: ORG, from: D1, to: D2, group: '기획팀' });
  const depts = [{ id: D1, name: '총무과', organization_id: ORG }, { id: D2, name: '기획팀', organization_id: ORG }];
  it('이 기관 부서면 지금 부서가 from인 일반 직원만 조건부로 옮기고 보안 로그를 남긴다', async () => {
    db.calls.length = 0; security.events.length = 0;
    db.respond = (table) => (table === 'departments' ? { data: depts, error: null } : { data: [{ id: 'u1' }], error: null });
    expect(await run()).toBe(true);
    const upd = db.calls.find((c) => c.table === 'users')!;
    expect(upd.ops).toEqual(expect.arrayContaining([['update', [{ department_id: D2 }]], ['eq', ['id', 'u1']], ['eq', ['department_id', D1]], ['eq', ['role', 'USER']], ['is', ['deleted_at', null]]]));
    expect(security.events[0]).toEqual([D2, 'u1', 'user_department_synced', expect.objectContaining({
      target_user_id: 'u1', from_department_name: '총무과', to_department_name: '기획팀', via: 'sso_group', sso_group: '기획팀',
    }), 'medium']);
  });
  it('바뀐 줄이 없으면 false·기록 없음, 다른 기관·없는 부서·읽기/쓰기 실패는 던진다(옮기지 않음)', async () => {
    security.events.length = 0;
    db.respond = (table) => (table === 'departments' ? { data: depts, error: null } : { data: [], error: null });
    expect(await run()).toBe(false);
    expect(security.events).toHaveLength(0);
    db.calls.length = 0;
    db.respond = (table) => (table === 'departments' ? { data: [depts[0], { ...depts[1], organization_id: 'other' }], error: null } : { data: [{ id: 'u1' }], error: null });
    await expect(run()).rejects.toThrow();
    expect(db.calls.some((c) => c.table === 'users')).toBe(false);
    db.respond = (table) => (table === 'departments' ? { data: [depts[0]], error: null } : { data: [], error: null });
    await expect(run()).rejects.toThrow();
    db.respond = () => ({ data: null, error: { code: 'XX' } });
    await expect(run()).rejects.toThrow();
    db.respond = (table) => (table === 'departments' ? { data: depts, error: null } : { data: null, error: { code: 'XX' } });
    await expect(run()).rejects.toThrow();
  });
});

describe('잇기', () => {
  it('감사 화면 이름표·상세(맞은 그룹)', () => {
    expect(SECURITY_EVENT_LABELS.user_department_synced).toBe('직원 부서 맞추기(기관 SSO 그룹)');
    expect(securityDetailParts({ sso_group: '기획팀', from_department_id: D1, to_department_id: D2, from_department_name: '총무과', to_department_name: '기획팀' }, () => null))
      .toEqual(expect.arrayContaining(['계정 서비스 그룹: 기획팀', '부서: 총무과 → 기획팀']));
  });
  it('관리자 SSO 라우트 — 부서 목록을 주고, 저장할 때 목록의 부서가 이 기관 것인지 본다', () => {
    const src = readFileSync('src/app/api/admin/sso/route.ts', 'utf8');
    expect(src).toContain('orgDepartments(scope.organizationId)');
    expect(src).toMatch(/\.in\('id', mappedIds\)\.eq\('organization_id', scope\.organizationId\)/);
    expect(src).toContain('group_mappings: saved.view.groupMappings.length');
  });
  it('설정 화면이 클레임·목록을 보낸다', () => {
    const src = readFileSync('src/components/admin/OrgSsoPanel.tsx', 'utf8');
    expect(src).toContain('groupClaim, groupMappings: mappings');
    expect(src).toContain('loaded.departments.map');
  });
});

const dbUrl = process.env.WORK_TEST_DATABASE_URL;
describe.skipIf(!dbUrl)('0110 — 그룹 맞추기 칸(시험 DB)', () => {
  let pgdb: pg.Client;
  beforeAll(async () => {
    if (/supabase\.(co|com)|pooler\./.test(dbUrl!)) throw new Error('운영 DB 주소로 보입니다 — 시험 DB를 쓰세요');
    pgdb = new pg.Client({ connectionString: dbUrl });
    await pgdb.connect();
  });
  afterAll(async () => { await pgdb?.end(); });
  it('여러 번 적용해도 안전·목록은 클레임과 함께·100줄까지', async () => {
    expect(existsSync('supabase/migrations/0110_org_sso_group_mapping.sql')).toBe(true);
    await pgdb.query('BEGIN');
    try {
      const sql = readFileSync('supabase/migrations/0110_org_sso_group_mapping.sql', 'utf8');
      await pgdb.query(sql); await pgdb.query(sql);
      const orgId = randomUUID();
      await pgdb.query('INSERT INTO organizations (id, name) VALUES ($1, $2)', [orgId, '0110 기관']);
      await pgdb.query("INSERT INTO org_sso_providers (organization_id, issuer, client_id) VALUES ($1, 'https://login.example.com', 'c')", [orgId]);
      expect((await pgdb.query('SELECT group_claim, group_mappings FROM org_sso_providers WHERE organization_id = $1', [orgId])).rows).toEqual([{ group_claim: null, group_mappings: [] }]);
      const one = JSON.stringify([{ value: 'a', departmentId: D1 }]);
      await pgdb.query('SAVEPOINT s');
      await expect(pgdb.query('UPDATE org_sso_providers SET group_mappings = $2 WHERE organization_id = $1', [orgId, one])).rejects.toThrow(/check/i);
      await pgdb.query('ROLLBACK TO SAVEPOINT s');
      await pgdb.query("UPDATE org_sso_providers SET group_claim = 'groups', group_mappings = $2 WHERE organization_id = $1", [orgId, one]);
      const many = JSON.stringify(Array.from({ length: 101 }, (_, i) => ({ value: `g${i}`, departmentId: D3 })));
      await pgdb.query('SAVEPOINT t');
      await expect(pgdb.query('UPDATE org_sso_providers SET group_mappings = $2 WHERE organization_id = $1', [orgId, many])).rejects.toThrow(/check/i);
      await pgdb.query('ROLLBACK TO SAVEPOINT t');
      await pgdb.query('SAVEPOINT u');
      await expect(pgdb.query("UPDATE org_sso_providers SET group_claim = '' WHERE organization_id = $1", [orgId])).rejects.toThrow(/check/i);
      await pgdb.query('ROLLBACK TO SAVEPOINT u');
    } finally {
      await pgdb.query('ROLLBACK');
    }
  });
});
