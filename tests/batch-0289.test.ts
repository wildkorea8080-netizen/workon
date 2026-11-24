import { readFileSync, existsSync } from 'fs';
import { randomUUID } from 'crypto';
import bcrypt from 'bcryptjs';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import pg from 'pg';

/**
 * 2026-11-25 — 기관 SSO 전용(0109). 기관 SSO(0107)를 켠 기관이 '직원은 기관 계정으로만'을 고르면
 * 직원(USER)의 이메일·비밀번호 로그인을 막고(비밀번호가 맞아도 SSO_ONLY), 비밀번호로 들어와 있던 직원 로그인은 미들웨어가 끝낸다.
 * 관리자(ADMIN)는 비밀번호 로그인을 그대로 쓴다 — 계정 서비스가 고장 나도 설정을 고칠 사람이 남게. 못 읽으면 막지 않는다(열림).
 */

const state = vi.hoisted(() => ({
  auth: { data: { user: null }, error: { status: 400, code: 'invalid_credentials', message: 'Invalid login credentials' } } as { data: { user: unknown }; error: unknown },
  usersRow: null as unknown,
  blocked: false, blockedCalls: [] as unknown[],
  records: [] as string[], dormantCalls: 0,
}));

vi.mock('@/lib/config', async (orig) => ({ ...(await orig<typeof import('@/lib/config')>()), NEXTAUTH_SECRET: 'x' }));
vi.mock('@/lib/logger', () => ({ logSystem: vi.fn(async () => {}) }));
vi.mock('@/lib/supabase', () => ({ supabase: { auth: { signInWithPassword: async () => state.auth } } }));
vi.mock('@/lib/supabaseAdmin', () => ({
  supabaseAdmin: {
    from: () => {
      const b: Record<string, unknown> = {};
      for (const n of ['select', 'eq']) b[n] = () => b;
      b.maybeSingle = async () => ({ data: state.usersRow, error: null });
      return b;
    },
  },
}));
vi.mock('@/lib/sign-in-throttle', async (orig) => ({
  ...(await orig<typeof import('@/lib/sign-in-throttle')>()),
  throttleDeps: () => ({}),
  signInLock: async () => null,
  noteSignInFailure: async () => {},
  noteSignInSuccess: async () => {},
}));
vi.mock('@/lib/sign-in-record', () => ({
  signInRecordDeps: () => ({}),
  recordSignIn: async (_d: unknown, input: { outcome: string }) => { state.records.push(input.outcome); },
}));
vi.mock('@/lib/dormant-lock', () => ({ dormantDeps: () => ({}), lockIfDormant: async () => { state.dormantCalls += 1; return false; } }));
vi.mock('@/lib/sso-only', async (orig) => ({
  ...(await orig<typeof import('@/lib/sso-only')>()),
  passwordLoginBlocked: async (user: unknown) => { state.blockedCalls.push(user); return state.blocked; },
}));

import { authOptions } from '@/lib/nextAuthOptions';
import { parseSsoConfig, saveSsoConfig, configView, ssoLoginForSlug, SSO_DEFAULT_LABEL, SSO_ONLY, SSO_ONLY_MESSAGE, ssoErrorMessage, type SsoConfigRow, type SsoIo } from '@/lib/org-sso';
import { passwordLoginBlocked, type SsoOnlyIo } from '@/lib/sso-only';
import { deptSsoOnly, readDeptSsoOnly, userSessionVerdict, SUPER_STATUS_STALE_MS, SUPER_STATUS_TTL_MS, type FetchLike } from '@/lib/middleware-db';

// 진짜 passwordLoginBlocked(위 mock은 로그인 시험용) — 원래 모듈에서 꺼낸다
const realBlocked: typeof passwordLoginBlocked = (await vi.importActual<typeof import('@/lib/sso-only')>('@/lib/sso-only')).passwordLoginBlocked;

const ORG = '11111111-1111-4111-8111-111111111111';
const DEPT = '22222222-2222-4222-8222-222222222222';
const ISSUER = 'https://login.example.com/tenant/v2.0';

const authorize = (password = 'Pass-word1') =>
  (authOptions.providers[0] as unknown as { options: { authorize: (c: unknown, r: unknown) => Promise<unknown> } })
    .options.authorize({ email: 'kim@org.go.kr', password }, { headers: {} });
const HASH = bcrypt.hashSync('Pass-word1', 4);
const localUser = (role = 'USER') => ({ id: 'u1', email: 'kim@org.go.kr', role, full_name: '김', department_id: DEPT, password_hash: HASH, is_active: true, deleted_at: null });

beforeEach(() => {
  state.auth = { data: { user: null }, error: { status: 400, code: 'invalid_credentials', message: 'Invalid login credentials' } };
  state.usersRow = null; state.blocked = false; state.blockedCalls = []; state.records = []; state.dormantCalls = 0;
});

describe('설정 입력', () => {
  const base = { issuer: ISSUER, clientId: 'c', enabled: true };
  it('켜진 SSO에서만 고른다 — 꺼진 SSO로 고르면 400(직원이 아무도 못 들어온다)', () => {
    expect(parseSsoConfig(base)).toMatchObject({ ok: true, value: { ssoOnly: false } });
    expect(parseSsoConfig({ ...base, ssoOnly: true })).toMatchObject({ ok: true, value: { ssoOnly: true } });
    expect(parseSsoConfig({ ...base, enabled: false, ssoOnly: true })).toMatchObject({ ok: false });
    expect(parseSsoConfig({ ...base, ssoOnly: 'yes' })).toMatchObject({ ok: false });
  });
  it('저장은 바뀐 칸에 sso_only를 남기고, 끄면 SSO 전용도 꺼진다', async () => {
    const row = (over: Partial<SsoConfigRow> = {}): SsoConfigRow => ({ organization_id: ORG, issuer: ISSUER, client_id: 'c', client_secret_encrypted: 'enc', email_domains: [], enabled: true, button_label: null, updated_at: null, ...over });
    const upserts: Record<string, unknown>[] = [];
    const io = (before: SsoConfigRow | null) => ({
      loadConfig: async () => before, now: () => 0, encrypt: (s: string) => s, publicHost: async () => true,
      fetch: (async () => new Response(JSON.stringify({ issuer: ISSUER, authorization_endpoint: `${ISSUER}/a`, token_endpoint: `${ISSUER}/t`, jwks_uri: `${ISSUER}/k` }), { status: 200 })) as unknown as typeof fetch,
      upsert: async (r: Record<string, unknown>) => { upserts.push(r); return { ...row(), ...r } as SsoConfigRow; },
    });
    const input = { issuer: ISSUER, clientId: 'c', clientSecret: null, emailDomains: [], enabled: true, ssoOnly: true, buttonLabel: SSO_DEFAULT_LABEL };
    const r = await saveSsoConfig(ORG, 'admin', input, io(row()));
    expect(r).toMatchObject({ ok: true, changed: ['sso_only'], view: { ssoOnly: true } });
    expect(upserts[0]).toMatchObject({ sso_only: true });
    const off = await saveSsoConfig(ORG, 'admin', { ...input, enabled: false }, io(row({ sso_only: true })));
    expect(upserts[1]).toMatchObject({ enabled: false, sso_only: false });
    expect(off).toMatchObject({ ok: true, changed: ['enabled', 'sso_only'], view: { ssoOnly: false } });
    // 옛 행(칸 없음)은 끔
    expect(configView(row())?.ssoOnly).toBe(false);
    expect(configView(row({ enabled: false, sso_only: true }))?.ssoOnly).toBe(false);
  });
  it('로그인 화면은 켜진 기관만 단추·SSO 전용을 받는다(못 읽으면 null — 비밀번호 칸은 그대로)', async () => {
    const io = (cfg: Partial<SsoConfigRow> | null, fail = false) => ({
      loadOrgBySlug: async () => { if (fail) throw new Error('x'); return { id: ORG, slug: 'a', status: 'active' }; },
      loadConfig: async () => (cfg ? { organization_id: ORG, issuer: ISSUER, client_id: 'c', client_secret_encrypted: 'enc', email_domains: [], enabled: true, button_label: null, updated_at: null, ...cfg } : null),
    }) as unknown as SsoIo;
    expect(await ssoLoginForSlug('a', io({ sso_only: true }))).toEqual({ label: SSO_DEFAULT_LABEL, ssoOnly: true });
    expect(await ssoLoginForSlug('a', io({}))).toEqual({ label: SSO_DEFAULT_LABEL, ssoOnly: false });
    expect(await ssoLoginForSlug('a', io({ enabled: false, sso_only: true }))).toBeNull();
    expect(await ssoLoginForSlug('a', io(null, true))).toBeNull();
  });
});

describe('막을지 판정(passwordLoginBlocked)', () => {
  const io = (flags: { enabled: boolean; sso_only?: boolean | null } | null, opt: { org?: string | null; failAt?: 'department' | 'config' } = {}) => {
    const warns: string[] = [];
    const value: SsoOnlyIo = {
      orgOfDepartment: async () => { if (opt.failAt === 'department') throw new Error('x'); return opt.org === undefined ? ORG : opt.org; },
      loadSsoFlags: async () => { if (opt.failAt === 'config') throw new Error('x'); return flags; },
      warn: async (s) => { warns.push(s); },
    };
    return { value, warns };
  };
  it('직원이고 기관이 켜진 SSO에 SSO 전용을 골랐을 때만 막는다', async () => {
    expect(await realBlocked({ role: 'USER', departmentId: DEPT }, io({ enabled: true, sso_only: true }).value)).toBe(true);
    expect(await realBlocked({ role: 'USER', departmentId: DEPT }, io({ enabled: true, sso_only: false }).value)).toBe(false);
    expect(await realBlocked({ role: 'USER', departmentId: DEPT }, io({ enabled: false, sso_only: true }).value)).toBe(false);
    expect(await realBlocked({ role: 'USER', departmentId: DEPT }, io(null).value)).toBe(false);
    expect(await realBlocked({ role: 'USER', departmentId: DEPT }, io({ enabled: true, sso_only: true }, { org: null }).value)).toBe(false);
  });
  it('관리자는 막지 않는다(계정 서비스가 고장 나도 설정을 고칠 사람)', async () => {
    expect(await realBlocked({ role: 'ADMIN', departmentId: DEPT }, io({ enabled: true, sso_only: true }).value)).toBe(false);
    expect(await realBlocked({ role: 'admin', departmentId: DEPT }, io({ enabled: true, sso_only: true }).value)).toBe(false);
  });
  it('못 읽으면 막지 않고 운영 기록에 남긴다', async () => {
    for (const failAt of ['department', 'config'] as const) {
      const x = io({ enabled: true, sso_only: true }, { failAt });
      expect(await realBlocked({ role: 'USER', departmentId: DEPT }, x.value)).toBe(false);
      expect(x.warns).toEqual([failAt]);
    }
  });
});

describe('실제 로그인 함수(authorize)', () => {
  it('저장해 둔 비밀번호 길 — 막힌 직원은 비밀번호가 맞아도 SSO_ONLY, 거절로 남기고 장기 미접속 확인 전에 멈춘다', async () => {
    state.usersRow = localUser(); state.blocked = true;
    await expect(authorize()).rejects.toThrow(SSO_ONLY);
    expect(state.records).toEqual(['login_rejected']);
    expect(state.dormantCalls).toBe(0);
    expect(state.blockedCalls[0]).toMatchObject({ role: 'USER', departmentId: DEPT });
  });
  it('막히지 않으면 지금처럼 들어온다 · 틀린 비밀번호는 판정하지 않고 실패', async () => {
    state.usersRow = localUser();
    expect(await authorize()).toMatchObject({ id: 'u1' });
    expect(state.records).toEqual(['login']);
    state.records = []; state.blockedCalls = []; state.blocked = true;
    expect(await authorize('Wrong-pass1')).toBeNull();
    expect(state.blockedCalls).toEqual([]);
    expect(state.records).toEqual(['login_failed']);
  });
  it('Supabase Auth 길도 같은 규칙', async () => {
    state.auth = { data: { user: { id: 'u2', email: 'kim@org.go.kr', user_metadata: {} } }, error: null };
    state.usersRow = { id: 'u2', email: 'kim@org.go.kr', role: 'USER', full_name: '김', department_id: DEPT, is_active: true, deleted_at: null };
    state.blocked = true;
    await expect(authorize()).rejects.toThrow(SSO_ONLY);
    expect(state.records).toEqual(['login_rejected']);
    expect(state.blockedCalls[0]).toMatchObject({ role: 'USER', departmentId: DEPT });
  });
});

describe('들어와 있던 로그인 끝내기(미들웨어)', () => {
  const cfg = { url: 'https://db.test', key: 'k' };
  const reply = (pages: unknown[], ok = true): { f: FetchLike; urls: string[] } => {
    const urls: string[] = [];
    let i = 0;
    return { urls, f: async (url) => { urls.push(url); const body = pages[i++]; return { ok, json: async () => body }; } };
  };
  it('부서 → 기관 → 설정을 읽는다(칸이 없으면 거절돼 error)', async () => {
    const r = reply([[{ organization_id: ORG }], [{ enabled: true, sso_only: true }]]);
    expect(await readDeptSsoOnly(cfg as never, DEPT, r.f)).toBe(true);
    expect(r.urls[0]).toContain(`departments?id=eq.${DEPT}&select=organization_id`);
    expect(r.urls[1]).toContain(`org_sso_providers?organization_id=eq.${ORG}&select=enabled,sso_only`);
    expect(await readDeptSsoOnly(cfg as never, DEPT, reply([[{ organization_id: ORG }], [{ enabled: true, sso_only: false }]]).f)).toBe(false);
    expect(await readDeptSsoOnly(cfg as never, DEPT, reply([[{ organization_id: ORG }], []]).f)).toBe(false);
    expect(await readDeptSsoOnly(cfg as never, DEPT, reply([[]]).f)).toBe(false);
    expect(await readDeptSsoOnly(cfg as never, DEPT, reply([[]], false).f)).toBe('error');
    expect(await readDeptSsoOnly(null, DEPT, reply([]).f)).toBe('error');
    expect(await readDeptSsoOnly(cfg as never, "x' or 1=1", reply([]).f)).toBe(false);
  });
  it('30초 기억, 못 읽으면 10분 안의 마지막 값, 그것도 없으면 끄지 않음(열림)', async () => {
    const cache = new Map<string, { on: boolean; at: number }>();
    const read = vi.fn(async () => true as boolean | 'error');
    expect(await deptSsoOnly(cache, DEPT, read, 0)).toBe(true);
    expect(await deptSsoOnly(cache, DEPT, read, SUPER_STATUS_TTL_MS - 1)).toBe(true);
    expect(read).toHaveBeenCalledTimes(1);
    read.mockResolvedValue('error');
    expect(await deptSsoOnly(cache, DEPT, read, SUPER_STATUS_STALE_MS - 1)).toBe(true);
    expect(await deptSsoOnly(cache, DEPT, read, SUPER_STATUS_STALE_MS + 1)).toBe(false);
    expect(await deptSsoOnly(new Map(), DEPT, read, 0)).toBe(false);
  });
  it('비밀번호로 들어온 직원만 끝낸다 — SSO 로그인·관리자·대리 접근은 그대로', async () => {
    const read = async () => ({ kind: 'active' as const, role: 'USER', departmentId: DEPT, passwordChangedAt: null, mustChangePassword: false });
    const on = async () => true;
    const token = { sub: 'u1', role: 'USER', departmentId: DEPT };
    expect(await userSessionVerdict(new Map(), token, read, 0, on)).toBe('sso_only');
    expect(await userSessionVerdict(new Map(), { ...token, sso: true }, read, 0, on)).toBe('ok');
    expect(await userSessionVerdict(new Map(), { ...token, isImpersonating: true }, read, 0, on)).toBe('ok');
    expect(await userSessionVerdict(new Map(), token, read, 0, async () => false)).toBe('ok');
    expect(await userSessionVerdict(new Map(), token, read, 0)).toBe('ok');
    const admin = async () => ({ kind: 'active' as const, role: 'ADMIN', departmentId: DEPT, passwordChangedAt: null, mustChangePassword: false });
    expect(await userSessionVerdict(new Map(), { ...token, role: 'ADMIN' }, admin, 0, on)).toBe('ok');
  });
});

describe('잇기', () => {
  it('로그인 두 길·미들웨어·화면이 같은 규칙을 쓴다', () => {
    const auth = readFileSync('src/lib/nextAuthOptions.ts', 'utf8');
    expect(auth.match(/passwordLoginBlocked\(/g)).toHaveLength(2);
    expect(auth.match(/throw new Error\(SSO_ONLY\)/g)).toHaveLength(2);
    const mw = readFileSync('src/middleware.ts', 'utf8');
    expect(mw).toContain('deptSsoOnly(ssoOnlyCache');
    expect(mw).toContain("verdict === 'sso_only' ? 'sso_only'");
    const form = readFileSync('src/components/auth/LoginForm.tsx', 'utf8');
    expect(form).toContain('res.error === SSO_ONLY ? SSO_ONLY_MESSAGE');
    expect(form).toContain('ssoLabel && ssoOnly');
    expect(ssoErrorMessage('sso_only')).toContain('기관 계정(SSO)으로만');
    expect(SSO_ONLY_MESSAGE).toContain('관리자만');
    expect(readFileSync('src/components/admin/OrgSsoPanel.tsx', 'utf8')).toContain('ssoOnly: enabled && ssoOnly');
    expect(readFileSync('src/app/api/admin/sso/route.ts', 'utf8')).toContain('sso_only: saved.view.ssoOnly');
  });
});

const dbUrl = process.env.WORK_TEST_DATABASE_URL;
describe.skipIf(!dbUrl)('0109 — SSO 전용 칸(시험 DB)', () => {
  let db: pg.Client;
  beforeAll(async () => {
    if (/supabase\.(co|com)|pooler\./.test(dbUrl!)) throw new Error('운영 DB 주소로 보입니다 — 시험 DB를 쓰세요');
    db = new pg.Client({ connectionString: dbUrl });
    await db.connect();
  });
  afterAll(async () => { await db?.end(); });
  it('여러 번 적용해도 안전·꺼진 SSO에는 걸 수 없음', async () => {
    expect(existsSync('supabase/migrations/0109_org_sso_only.sql')).toBe(true);
    await db.query('BEGIN');
    try {
      const sql = readFileSync('supabase/migrations/0109_org_sso_only.sql', 'utf8');
      await db.query(sql); await db.query(sql);
      const orgId = randomUUID();
      await db.query('INSERT INTO organizations (id, name) VALUES ($1, $2)', [orgId, '0109 기관']);
      await db.query("INSERT INTO org_sso_providers (organization_id, issuer, client_id, client_secret_encrypted, enabled, sso_only) VALUES ($1, 'https://login.example.com', 'c', 'enc', true, true)", [orgId]);
      expect((await db.query('SELECT sso_only FROM org_sso_providers WHERE organization_id = $1', [orgId])).rows).toEqual([{ sso_only: true }]);
      await db.query('SAVEPOINT s');
      await expect(db.query('UPDATE org_sso_providers SET enabled = false WHERE organization_id = $1', [orgId])).rejects.toThrow(/check/i);
      await db.query('ROLLBACK TO SAVEPOINT s');
      await db.query('UPDATE org_sso_providers SET enabled = false, sso_only = false WHERE organization_id = $1', [orgId]);
    } finally {
      await db.query('ROLLBACK');
    }
  });
});
