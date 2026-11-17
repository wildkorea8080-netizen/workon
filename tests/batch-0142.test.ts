import { readFileSync } from 'fs';
import { describe, expect, it, vi, beforeEach } from 'vitest';

/**
 * 2026-11-17 — 기관 로그인 경로(slug). 예전엔 슈퍼관리자 '기관 등록'이 입력받은 Slug를 기관(`organizations.slug`, 0020)에 저장하지 않아
 * 새 기관은 `/signin/{slug}` 로그인 화면이 없었고, 기관 상세의 '접속 URL'은 없는 주소 `/org/{slug}`를 복사했다.
 */

const state: { orgDup: unknown; deptDup: unknown; inserted: Record<string, unknown>[] } = { orgDup: null, deptDup: null, inserted: [] };

function builder(table: string) {
  const b: Record<string, unknown> = {};
  let insertRow: Record<string, unknown> | null = null;
  for (const n of ['select', 'eq', 'is', 'order', 'limit', 'range', 'single']) b[n] = () => b;
  b.insert = (row: Record<string, unknown>) => { insertRow = row; state.inserted.push({ table, ...row }); return b; };
  b.maybeSingle = () => Promise.resolve({ data: table === 'organizations' ? state.orgDup : state.deptDup, error: null });
  // 첫 insert(기관)에서 멈추게 실패를 돌려준다 — 저장하려던 값만 본다
  b.then = (ok: (v: unknown) => unknown, bad?: (e: unknown) => unknown) =>
    Promise.resolve(insertRow ? { data: null, error: { code: 'XX000', message: 'stop' } } : { data: [], error: null }).then(ok, bad);
  return b;
}

vi.mock('@/lib/supabaseAdmin', () => ({ supabaseAdmin: { from: (t: string) => builder(t), auth: { admin: {} } } }));
vi.mock('@/lib/super-auth', () => ({ getSuperAdminFromRequest: () => ({ sub: 'admin-1' }) }));
vi.mock('@/lib/audit-write', () => ({ writeAuditRow: async () => true }));
vi.mock('@/lib/logger', () => ({ logSystem: async () => {} }));
vi.mock('@/lib/config', () => ({ APP_URL: 'https://app.example' }));
vi.mock('@/lib/install-presets', () => ({ installPresetAgents: async () => ({ installed: [] }) }));

import { ORG_SLUG_PATTERN, normalizeOrgSlug, orgSignInPath } from '@/lib/org-slug';
import { POST as createOrg } from '@/app/api/super/organizations/route';

const req = (body: unknown) => new Request('http://x', { method: 'POST', body: JSON.stringify(body) }) as never;

beforeEach(() => { state.orgDup = null; state.deptDup = null; state.inserted = []; });

describe('규칙', () => {
  it('기관 관리자와 같은 규칙 — 3~40자, 하이픈으로 시작·끝 안 됨, 소문자로', () => {
    expect(normalizeOrgSlug(' Oasan-Digital ')).toEqual({ ok: true, slug: 'oasan-digital' });
    for (const v of ['ab', '-abc', 'abc-', 'a_b', '한글', 'a'.repeat(41), '', null]) expect(normalizeOrgSlug(v).ok, String(v)).toBe(false);
    expect(ORG_SLUG_PATTERN.test('org-eb36b9e4')).toBe(true);
  });
  it('로그인 주소는 /signin/{slug}', () => {
    expect(orgSignInPath('oasan')).toBe('/signin/oasan');
    expect(orgSignInPath(null)).toBeNull();
    expect(orgSignInPath('')).toBeNull();
  });
  it('잎 파일·기관 관리자도 같은 규칙을 쓴다', () => {
    expect(readFileSync('src/lib/org-slug.ts', 'utf8')).not.toMatch(/^import /m);
    expect(readFileSync('src/app/api/admin/organization/route.ts', 'utf8')).toContain('const SLUG_PATTERN = ORG_SLUG_PATTERN;');
  });
});

describe('기관 등록(POST /api/super/organizations)', () => {
  const body = { name: '오산시 디지털재단', slug: 'Oasan-Digital', adminEmail: 'a@b.kr' };
  it('입력한 slug를 기관에 저장한다', async () => {
    await createOrg(req(body));
    const org = state.inserted.find((r) => r.table === 'organizations');
    expect(org).toMatchObject({ slug: 'oasan-digital', name: '오산시 디지털재단' });
  });
  it('규칙에 안 맞으면 400 — 아무것도 넣지 않음', async () => {
    const res = await createOrg(req({ ...body, slug: '-bad' }));
    expect(res.status).toBe(400);
    expect(state.inserted).toEqual([]);
  });
  it('다른 기관이 쓰는 로그인 경로면 409', async () => {
    state.orgDup = { id: 'o2' };
    expect((await createOrg(req(body))).status).toBe(409);
    expect(state.inserted).toEqual([]);
  });
  it('기본 부서 slug가 겹쳐도 409(예전 검사 그대로)', async () => {
    state.deptDup = { id: 'd2' };
    expect((await createOrg(req(body))).status).toBe(409);
  });
});

describe('화면', () => {
  it('기관 상세는 /signin/{slug}를 보이고 복사(없는 /org/ 주소 안 씀)', () => {
    const s = readFileSync('src/app/super/organizations/[id]/page.tsx', 'utf8');
    expect(s).toContain('orgSignInPath(org.slug)');
    expect(s).not.toMatch(/\/org\/\$\{/);
  });
  it('등록 창 안내도 /signin/', () => {
    const s = readFileSync('src/app/super/organizations/page.tsx', 'utf8');
    expect(s).toContain('기관 로그인 주소: /signin/{form.slug}');
    expect(s).not.toContain('/org/{form.slug}');
  });
});
