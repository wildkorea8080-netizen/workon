import { readFileSync } from 'fs';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  readIpPolicy, readMaintenance, readSuperAdminStatus, restConfig, superAdminActive, superTokenSub,
  SUPER_STATUS_STALE_MS, SUPER_STATUS_TTL_MS, type FetchLike,
} from '@/lib/middleware-db';

/**
 * 2026-11-13 — 공개 키로 열려 있던 DB와 미들웨어.
 * ① RLS가 꺼진 표 여섯·뷰 둘·departments를 공개 키(브라우저에 실림)로 읽고 쓸 수 있었다 → 0090
 * ② 미들웨어가 공개 키로 점검 모드·접속 허용 IP를 읽어 언제나 0행 — 두 기능이 걸린 적이 없었다 → 서비스 키
 * ③ 비활성화한 슈퍼관리자 토큰이 24시간 쓰였다 → 미들웨어가 계정 상태를 본다
 */

const cfg = { url: 'https://db.example', key: 'service' };
const ok = (body: unknown) => ({ ok: true, json: async () => body });
const fail = () => ({ ok: false, json: async () => ({}) });
const SUB = '11111111-1111-4111-8111-111111111111';

describe('서비스 키로 읽기', () => {
  it('설정은 서비스 키만 — 공개 키는 쓰지 않는다', () => {
    expect(restConfig({ NEXT_PUBLIC_SUPABASE_URL: 'https://db.example/', SUPABASE_SERVICE_ROLE_KEY: 's' })).toEqual({ url: 'https://db.example', key: 's' });
    expect(restConfig({ NEXT_PUBLIC_SUPABASE_URL: 'https://db.example' })).toBeNull();
  });
  it('점검 모드 — 켜짐·메시지, 못 읽으면 꺼짐(ok:false)', async () => {
    const f = vi.fn(async () => ok([{ key: 'maintenance_mode', value: 'true' }, { key: 'maintenance_message', value: '점검' }])) as unknown as FetchLike;
    expect(await readMaintenance(cfg, f)).toEqual({ on: true, message: '점검', ok: true });
    expect((f as unknown as ReturnType<typeof vi.fn>).mock.calls[0][1]).toEqual({ headers: { apikey: 'service', Authorization: 'Bearer service' } });
    expect(await readMaintenance(cfg, (async () => fail()) as FetchLike)).toEqual({ on: false, message: '', ok: false });
    expect(await readMaintenance(null, (async () => ok([])) as FetchLike)).toMatchObject({ on: false, ok: false });
  });
  it('접속 허용 IP — 켠 기관의 부서만, 못 읽으면 빈 표', async () => {
    const f = (async (url: string) => url.includes('/organizations')
      ? ok([{ id: 'o1', allowed_ips: ['10.0.0.0/8'] }, { id: 'o2', allowed_ips: [] }])
      : ok([{ id: 'd1', organization_id: 'o1' }])) as FetchLike;
    expect([...(await readIpPolicy(cfg, f))]).toEqual([['d1', ['10.0.0.0/8']]]);
    expect((await readIpPolicy(cfg, (async () => fail()) as FetchLike)).size).toBe(0);
  });
});

describe('슈퍼관리자 계정 상태', () => {
  it('활성 슈퍼관리자만 active, 비활성·삭제·일반 계정·없음은 inactive, 못 읽으면 error', async () => {
    const row = (r: object) => (async () => ok([r])) as FetchLike;
    expect(await readSuperAdminStatus(cfg, SUB, row({ is_super_admin: true, is_active: true, deleted_at: null }))).toBe('active');
    expect(await readSuperAdminStatus(cfg, SUB, row({ is_super_admin: true, is_active: false, deleted_at: null }))).toBe('inactive');
    expect(await readSuperAdminStatus(cfg, SUB, row({ is_super_admin: true, is_active: true, deleted_at: '2026-11-13' }))).toBe('inactive');
    expect(await readSuperAdminStatus(cfg, SUB, row({ is_super_admin: false, is_active: true }))).toBe('inactive');
    expect(await readSuperAdminStatus(cfg, SUB, (async () => ok([])) as FetchLike)).toBe('inactive');
    expect(await readSuperAdminStatus(cfg, SUB, (async () => fail()) as FetchLike)).toBe('error');
    expect(await readSuperAdminStatus(null, SUB, (async () => ok([])) as FetchLike)).toBe('error');
  });
  it('uuid가 아닌 sub는 묻지 않고 inactive(주소 조작 막기)', async () => {
    const f = vi.fn();
    expect(await readSuperAdminStatus(cfg, 'x&is_super_admin=eq.false', f as unknown as FetchLike)).toBe('inactive');
    expect(f).not.toHaveBeenCalled();
  });
  it('30초 기억, 못 읽으면 10분 안의 마지막 값, 그것도 없으면 막음', async () => {
    const cache = new Map<string, { active: boolean; at: number }>();
    const read = vi.fn(async () => 'active' as const);
    expect(await superAdminActive(cache, SUB, read, 1_000)).toBe(true);
    expect(await superAdminActive(cache, SUB, read, 1_000 + SUPER_STATUS_TTL_MS - 1)).toBe(true);
    expect(read).toHaveBeenCalledTimes(1);
    // 비활성화되면 30초 안에 막힌다
    const inactive = vi.fn(async () => 'inactive' as const);
    expect(await superAdminActive(cache, SUB, inactive, 1_000 + SUPER_STATUS_TTL_MS)).toBe(false);
    // 못 읽음 — 10분 안의 활성 기억은 이어 쓰고, 지나면 막는다
    const fresh = new Map([[SUB, { active: true, at: 0 }]]);
    const err = vi.fn(async () => 'error' as const);
    expect(await superAdminActive(fresh, SUB, err, SUPER_STATUS_STALE_MS - 1)).toBe(true);
    expect(await superAdminActive(fresh, SUB, err, SUPER_STATUS_STALE_MS + 1)).toBe(false);
    expect(await superAdminActive(new Map(), SUB, err, 0)).toBe(false);
  });
  it('토큰에서 sub만 꺼낸다', () => {
    const payload = Buffer.from(JSON.stringify({ sub: SUB, exp: 1 })).toString('base64url');
    expect(superTokenSub(`h.${payload}.s`)).toBe(SUB);
    expect(superTokenSub('broken')).toBeNull();
  });
});

describe('연결(원본)', () => {
  const mw = readFileSync('src/middleware.ts', 'utf8');
  it('미들웨어는 공개 키로 DB를 읽지 않는다', () => {
    expect(mw).not.toContain('NEXT_PUBLIC_SUPABASE_ANON_KEY');
    expect(mw).toContain('readMaintenance(restConfig(), fetch)');
    expect(mw).toContain('readIpPolicy(restConfig(), fetch)');
  });
  it('슈퍼관리자 화면·API·점검 모드 통과 모두 계정 상태를 본다', () => {
    expect(mw).toContain('const isSuperAdmin = superToken ? await superTokenActive(superToken) : false;');
    expect(mw).toContain("if (pathname.startsWith('/api/super')) {");
    expect(mw).toMatch(/verifySuperTokenEdge\(superToken\)\) && !\(await superTokenActive\(superToken\)\)/);
    expect(mw).toContain('const valid = await superTokenActive(superToken);');
  });
});

const url = process.env.WORK_TEST_DATABASE_URL;
describe.skipIf(!url)('0090 공개 키 닫기 (시험 DB)', () => {
  let db: pg.Client;
  beforeAll(async () => {
    if (/supabase\.(co|com)|pooler\./.test(url!)) throw new Error('운영 DB 주소로 보입니다 — 시험 DB를 쓰세요');
    db = new pg.Client({ connectionString: url });
    await db.connect();
  });
  afterAll(async () => { await db?.end(); });
  it('RLS 꺼진 표·공개 정책·anon 권한을 모두 닫고, 두 번 적용해도 된다', async () => {
    const sql = readFileSync('supabase/migrations/0090_close_public_key_access.sql', 'utf8');
    await db.query('BEGIN');
    try {
      await db.query("DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN CREATE ROLE anon NOLOGIN; END IF; IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN CREATE ROLE authenticated NOLOGIN; END IF; END $$");
      // 운영에 있던 꼴을 만든다: RLS 꺼진 표 + anon 전체 권한, 공개 정책, anon이 읽는 뷰
      await db.query('CREATE TABLE public.t0090_open (id int)');
      await db.query('GRANT ALL ON public.t0090_open TO anon');
      await db.query('CREATE POLICY p0090_public ON public.departments FOR SELECT TO public USING (true)');
      await db.query('CREATE VIEW public.v0090 AS SELECT id FROM public.t0090_open');
      await db.query('GRANT SELECT ON public.v0090 TO anon, authenticated');
      await db.query(sql);
      await db.query(sql);
      const noRls = await db.query("SELECT count(*)::int n FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relkind IN ('r','p') AND NOT c.relrowsecurity");
      expect(noRls.rows[0].n).toBe(0);
      const policies = await db.query("SELECT count(*)::int n FROM pg_policies WHERE schemaname = 'public' AND roles && ARRAY['public','anon','authenticated']::name[]");
      expect(policies.rows[0].n).toBe(0);
      const grants = await db.query("SELECT count(*)::int n FROM information_schema.role_table_grants WHERE grantee IN ('anon','authenticated') AND table_schema = 'public'");
      expect(grants.rows[0].n).toBe(0);
      const priv = await db.query("SELECT has_table_privilege('anon', 'public.v0090', 'SELECT') v, has_table_privilege('anon', 'public.t0090_open', 'INSERT') t");
      expect(priv.rows[0]).toEqual({ v: false, t: false });
    } finally { await db.query('ROLLBACK'); }
  });
});
