import { readFileSync } from 'fs';
import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * 2026-11-18 — 기관 정보 저장(`PATCH /api/admin/organization`).
 * - 저장 응답에 `allowed_ips`·`currentIp`·`availableModels`가 없었고 화면은 그 응답으로 상태를 통째로 바꿨다 →
 *   저장하고 나면 접속 허용 IP 칸이 비고, **그대로 한 번 더 저장하면 접속 허용 IP가 지워졌다**
 * - 접속 허용 IP(기관 전체의 접속을 막는 통제)를 바꾸거나 없애도 어디에도 남지 않았다
 * - 화면은 저장마다 모든 칸을 보내는데, 이름만 고쳐도 모델 정책 이력이 한 줄씩 쌓였다(고치기 전 값을 못 읽으면 '정한 적 없음'으로 남김)
 */

type Call = { table: string; ops: Array<[string, unknown[]]> };
type Result = { data?: unknown; error: unknown };
const ERR = { code: 'XX000', message: 'boom' };

const BEFORE = {
  id: 'org1', name: '시험 기관', slug: 'test-org', logo_url: null, ai_notice: null, theme_color: null, domain: 'x.kr', type: '공공기관',
  allowed_models: ['m1', 'm2'], allowed_ips: ['203.0.113.0/24'], dormant_lock_days: null, dormant_lock_since: null,
};

const state: {
  session: unknown;
  calls: Call[];
  dept: Result;
  before: Result;
  updateError: unknown;
  wholeOrg: boolean;
  audits: Array<{ table: string; row: Record<string, unknown>; kind: string }>;
  logs: Array<{ dept: unknown; user: unknown; type: string; details: Record<string, unknown>; severity: string }>;
} = { session: null, calls: [], dept: { data: null, error: null }, before: { data: null, error: null }, updateError: null, wholeOrg: true, audits: [], logs: [] };

const did = (c: Call, name: string) => c.ops.some(([n]) => n === name);

function resolve(c: Call): Result {
  if (c.table === 'departments') return state.dept;
  if (c.table === 'organizations') {
    if (did(c, 'update')) {
      if (state.updateError) return { data: null, error: state.updateError };
      const patch = (c.ops.find(([n]) => n === 'update')?.[1] as [Record<string, unknown>])[0];
      return { data: { ...(state.before.data as object), ...patch }, error: null };
    }
    return state.before;
  }
  throw new Error(`unexpected table ${c.table}`);
}

vi.mock('@/lib/auth', () => ({
  getServerAuthSession: async () => state.session,
  isAdminSession: (s: { user?: { role?: string } } | null) => s?.user?.role === 'ADMIN',
}));
vi.mock('@/lib/config', () => ({ SUPABASE_DOCUMENTS_BUCKET: 'documents' }));
vi.mock('@/lib/actor-scope', () => ({ getActorScope: async () => ({ managesWholeOrganization: state.wholeOrg, organizationId: 'org1' }) }));
vi.mock('@/lib/models', () => ({
  enabledModels: () => [
    { id: 'm1', label: '모델 1', provider: 'anthropic', inputPerMTok: 3, outputPerMTok: 15 },
    { id: 'm2', label: '모델 2', provider: 'anthropic', inputPerMTok: 5, outputPerMTok: 25 },
  ],
}));
vi.mock('@/lib/model-policy', () => ({ getAllowedModelIds: async () => ['m1', 'm2'] }));
vi.mock('@/lib/audit-write', () => ({
  writeAuditRow: async (table: string, row: Record<string, unknown>, kind: string) => { state.audits.push({ table, row, kind }); return true; },
}));
vi.mock('@/lib/security-log', () => ({
  logSecurityEvent: async (dept: unknown, user: unknown, type: string, details: Record<string, unknown>, severity: string) => {
    state.logs.push({ dept, user, type, details, severity });
    return true;
  },
}));
vi.mock('@/lib/supabaseAdmin', () => ({
  supabaseAdmin: {
    from: (table: string) => {
      const call: Call = { table, ops: [] };
      state.calls.push(call);
      const b: Record<string, unknown> = {};
      for (const n of ['select', 'eq', 'update']) b[n] = (...args: unknown[]) => { call.ops.push([n, args]); return b; };
      b.single = async () => resolve(call);
      b.maybeSingle = async () => resolve(call);
      return b;
    },
  },
}));

import { GET, PATCH } from '@/app/api/admin/organization/route';
import { organizationChanges, sameList } from '@/lib/organization-audit';
import { SECURITY_EVENT_LABELS, securityDetailParts } from '@/lib/security-event-text';

const headers = () => new Headers({ 'content-type': 'application/json', 'x-forwarded-for': '203.0.113.7' });
const patch = async (body: unknown) => {
  const res = (await PATCH({ headers: headers(), json: async () => body } as never))!;
  return { status: res.status, body: await res.json() };
};
/** 화면이 저장마다 보내는 꼴 — 모든 칸 */
const screenBody = (over: Record<string, unknown> = {}) => ({
  name: '시험 기관', slug: 'test-org', ai_notice: '', theme_color: null, allowed_models: ['m1', 'm2'], allowed_ips: '203.0.113.0/24', ...over,
});
const updates = () => state.calls.filter((c) => c.table === 'organizations' && did(c, 'update'));

beforeEach(() => {
  state.session = { user: { id: 'admin1', role: 'ADMIN', departmentId: 'd1' } };
  state.calls = [];
  state.audits = [];
  state.logs = [];
  state.dept = { data: { organization_id: 'org1' }, error: null };
  state.before = { data: { ...BEFORE }, error: null };
  state.updateError = null;
  state.wholeOrg = true;
});

describe('저장 응답 — 조회와 같은 칸', () => {
  it('저장 응답에 접속 허용 IP·지금 주소·모델 목록이 있다(화면이 이 응답으로 상태를 바꾼다)', async () => {
    const got = (await GET({ headers: headers() } as never))!;
    const getKeys = Object.keys((await got.json()).data).sort();
    const saved = await patch(screenBody());
    expect(saved.status).toBe(200);
    expect(Object.keys(saved.body.data).sort()).toEqual(getKeys);
    expect(saved.body.data.allowed_ips).toEqual(['203.0.113.0/24']);
    expect(saved.body.data.currentIp).toBe('203.0.113.7');
    expect(saved.body.data.availableModels).toHaveLength(2);
    expect(saved.body.data.effectiveModels).toEqual(['m1', 'm2']);
  });

  it('화면은 응답을 앞 값에 합치고, 접속 허용 IP 칸은 응답에 그 값이 있을 때만 바꾼다', () => {
    const ui = readFileSync('src/components/admin/OrganizationManager.tsx', 'utf8');
    expect(ui).not.toContain('setOrg(result.data);');
    expect(ui.match(/setOrg\(\(prev\) => \(prev \? \{ \.\.\.prev, \.\.\.result\.data \} : result\.data\)\);/g)).toHaveLength(3);
    expect(ui).toContain("if ('allowed_ips' in result.data) setAllowedIps(");
  });
});

describe('달라진 것만 기록', () => {
  it('같은 값을 다시 저장하면 모델 정책 이력도 보안 로그도 없다', async () => {
    const saved = await patch(screenBody({ allowed_models: ['m2', 'm1'] }));
    expect(saved.status).toBe(200);
    expect(state.audits).toHaveLength(0);
    expect(state.logs).toHaveLength(0);
  });

  it('접속 허용 IP를 바꾸면 high로 전후 목록, 없애면 빈 목록', async () => {
    await patch(screenBody({ allowed_ips: '203.0.113.0/24\n198.51.100.9' }));
    expect(state.logs).toEqual([{
      dept: 'd1', user: 'admin1', type: 'org_access_ips_changed', severity: 'high',
      details: { from_ips: ['203.0.113.0/24'], to_ips: ['203.0.113.0/24', '198.51.100.9'], from_ip_count: 1, to_ip_count: 2 },
    }]);

    state.logs = [];
    await patch(screenBody({ allowed_ips: '' }));
    expect(state.logs[0]).toMatchObject({ type: 'org_access_ips_changed', severity: 'high', details: { to_ips: [], to_ip_count: 0 } });
    expect(updates().at(-1)!.ops.find(([n]) => n === 'update')![1]).toMatchObject([{ allowed_ips: null }]);
  });

  it('기관명·로그인 경로는 전후 값, AI 고지·테마 색·로고는 바꿨다는 것만(low)', async () => {
    await patch(screenBody({ name: '새 기관', slug: 'new-org', ai_notice: '고지 문구', theme_color: '#1d4ed8' }));
    expect(state.logs).toEqual([{
      dept: 'd1', user: 'admin1', type: 'organization_updated', severity: 'low',
      details: { from_org_name: '시험 기관', to_org_name: '새 기관', from_slug: 'test-org', to_slug: 'new-org', changed_fields: ['ai_notice', 'theme_color'] },
    }]);
    expect(JSON.stringify(state.logs)).not.toContain('고지 문구');
  });

  it('허용 모델이 실제로 달라졌을 때만 모델 정책 이력 한 줄', async () => {
    await patch(screenBody({ allowed_models: ['m1'] }));
    expect(state.audits).toEqual([{
      table: 'model_policy_logs', kind: 'allowed_models_changed',
      row: { organization_id: 'org1', changed_by: 'admin1', before_models: ['m1', 'm2'], after_models: ['m1'] },
    }]);
    expect(state.logs).toHaveLength(0);
  });

  it('대리 접근이면 표시가 남는다', async () => {
    state.session = { user: { id: 'admin1', role: 'ADMIN', departmentId: 'd1', isImpersonating: true } };
    await patch(screenBody({ allowed_ips: '', name: '새 기관' }));
    expect(state.logs.map((l) => l.details.impersonating)).toEqual([true, true]);
  });
});

describe('읽기 실패·권한', () => {
  it('고치기 전 값을 못 읽으면 저장하지 않는다(503) — 이력에 "정한 적 없음"으로 남기지 않는다', async () => {
    state.before = { data: null, error: ERR };
    const saved = await patch(screenBody({ allowed_models: ['m1'] }));
    expect(saved.status).toBe(503);
    expect(updates()).toHaveLength(0);
    expect(state.audits).toHaveLength(0);
  });

  it('부서를 못 읽으면 "기관 없음"(409)이 아니라 503', async () => {
    state.dept = { data: null, error: ERR };
    expect((await patch(screenBody())).status).toBe(503);
    state.dept = { data: { organization_id: null }, error: null };
    expect((await patch(screenBody())).status).toBe(409);
  });

  it('기관 전체 관리자가 아니면 403, 깨진 요청은 400, 저장 실패면 기록 없음', async () => {
    state.wholeOrg = false;
    expect((await patch(screenBody())).status).toBe(403);
    state.wholeOrg = true;

    const res = (await PATCH({ headers: headers(), json: async () => { throw new Error('bad'); } } as never))!;
    expect(res.status).toBe(400);

    state.updateError = ERR;
    expect((await patch(screenBody({ allowed_ips: '' }))).status).toBe(500);
    state.updateError = { code: '23505', message: 'dup' };
    expect((await patch(screenBody({ slug: 'taken' }))).status).toBe(409);
    expect(state.logs).toHaveLength(0);
  });
});

describe('organizationChanges·sameList', () => {
  it('목록은 순서·겹침을 보지 않고, null과 빈 목록은 같다', () => {
    expect(sameList(['a', 'b'], ['b', 'a', 'a'])).toBe(true);
    expect(sameList(null, [])).toBe(true);
    expect(sameList(['a'], ['a', 'b'])).toBe(false);
    expect(sameList(null, ['a'])).toBe(false);
  });

  it('보내지 않은 칸은 달라진 것으로 보지 않는다', () => {
    expect(organizationChanges(BEFORE, {})).toEqual({ ips: null, info: null });
    expect(organizationChanges(BEFORE, { logo_url: null })).toEqual({ ips: null, info: null });
  });

  it('로고는 올리면(같은 경로여도) 바뀐 것, 있던 로고를 지우면 바뀐 것', () => {
    expect(organizationChanges({ ...BEFORE, logo_url: 'branding/org1/logo.png' }, { logo_url: 'branding/org1/logo.png' }).info)
      .toEqual({ changed_fields: ['logo'] });
    expect(organizationChanges({ ...BEFORE, logo_url: 'branding/org1/logo.png' }, { logo_url: null }).info)
      .toEqual({ changed_fields: ['logo'] });
  });

  it('접속 허용 IP는 50개까지만 싣고 개수는 그대로', () => {
    const many = Array.from({ length: 60 }, (_, i) => `10.0.0.${i}`);
    const { ips } = organizationChanges(BEFORE, { allowed_ips: many });
    expect(ips?.to_ips).toHaveLength(50);
    expect(ips?.to_ip_count).toBe(60);
  });
});

describe('감사 화면의 이름표·상세', () => {
  const noName = () => null;

  it('이름표', () => {
    expect(SECURITY_EVENT_LABELS.org_access_ips_changed).toBe('접속 허용 IP 바꾸기(관리자)');
    expect(SECURITY_EVENT_LABELS.organization_updated).toBe('기관 정보 바꾸기(관리자)');
  });

  it('접속 허용 IP — 전후 목록, 비면 제한 없음, 많으면 "외 N개"', () => {
    expect(securityDetailParts({ from_ips: ['203.0.113.0/24'], to_ips: [], from_ip_count: 1, to_ip_count: 0 }, noName))
      .toEqual(['접속 허용 IP: 203.0.113.0/24 → 제한 없음']);
    const many = Array.from({ length: 7 }, (_, i) => `10.0.0.${i}`);
    expect(securityDetailParts({ from_ips: [], to_ips: many, from_ip_count: 0, to_ip_count: 7 }, noName))
      .toEqual(['접속 허용 IP: 제한 없음 → 10.0.0.0, 10.0.0.1, 10.0.0.2, 10.0.0.3, 10.0.0.4 외 2개']);
  });

  it('기관 정보 — 기관명·로그인 경로·바꾼 것', () => {
    expect(securityDetailParts({
      from_org_name: '시험 기관', to_org_name: '새 기관', from_slug: null, to_slug: 'new-org', changed_fields: ['ai_notice', 'theme_color', 'logo', 'unknown'],
    }, noName)).toEqual(['기관명: 시험 기관 → 새 기관', '로그인 경로: (없음) → new-org', '바꾼 것: AI 고지 문구, 테마 색, 로고']);
  });
});
