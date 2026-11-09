import { readFileSync } from 'fs';
import { describe, expect, it, vi } from 'vitest';
import {
  ORG_API_CREATOR_UNAVAILABLE, ORG_API_DAILY_LIMITED, ORG_API_INVALID_TOKEN, ORG_API_IP_DENIED, ORG_API_SCOPE_DENIED,
  bearerOrgApiToken, keyView, parseCreateKey, parseUsagePeriod,
} from '@/lib/org-api/spec';
import { generateOrgApiToken, handleOrgApiCall, hashOrgApiToken, type OrgApiDeps } from '@/lib/org-api/keys';
import { PERSONAL_AGENT_LABEL, USAGE_USER_AXIS_DENIED, agentNameEntry, usageSummary } from '@/lib/org-api/reports';
import { wholeOrgAdminProblem } from '@/lib/org-api/admin';
import type { ActorScope } from '@/lib/agent-permissions';
import { curlExample } from '@/components/admin/OrgApiKeysPanel';

/** 기관 통계 읽기 API(0075, 2026-11-09) — 범위 제한 키·호출 확인·숫자만 */

describe('키·요청 꼴', () => {
  it('키는 wo_api_ + 32바이트, 해시는 SHA-256, 앞부분 12자', () => {
    const t = generateOrgApiToken();
    expect(t.token).toMatch(/^wo_api_[A-Za-z0-9_-]{43}$/);
    expect(t.hash).toBe(hashOrgApiToken(t.token));
    expect(t.hash).toMatch(/^[0-9a-f]{64}$/);
    expect(t.prefix).toBe(t.token.slice(0, 12));
    expect(generateOrgApiToken().token).not.toBe(t.token);
  });
  it('Bearer에서 키를 꺼낸다 — 다른 접두(연동 토큰)·빈 값·짧은 값은 null', () => {
    const t = generateOrgApiToken().token;
    expect(bearerOrgApiToken(`Bearer ${t}`)).toBe(t);
    expect(bearerOrgApiToken(`bearer   ${t} `)).toBe(t);
    expect(bearerOrgApiToken('Bearer wo_wh_abcdefghijklmnopqrstuvwxyz')).toBeNull();
    expect(bearerOrgApiToken('Bearer wo_api_x')).toBeNull();
    expect(bearerOrgApiToken(t)).toBeNull();
    expect(bearerOrgApiToken(null)).toBeNull();
  });
  it('키 만들기 검사 — 이름 다듬기·40자, 범위는 정해 둔 것만·정해 둔 순서로, 유효 기간 30·90·365', () => {
    expect(parseCreateKey({ name: ' 경영정보\n대시보드 ', scopes: ['usage', 'adoption', 'usage'], days: 90 })).toEqual({ ok: true, value: { name: '경영정보 대시보드', scopes: ['adoption', 'usage'], days: 90 } });
    expect(parseCreateKey({ name: '', scopes: ['usage'], days: 30 })).toMatchObject({ ok: false });
    expect(parseCreateKey({ name: 'x'.repeat(41), scopes: ['usage'], days: 30 })).toMatchObject({ ok: false });
    expect(parseCreateKey({ name: 'x', scopes: [], days: 30 })).toMatchObject({ ok: false, message: '읽을 범위를 하나 이상 고르세요.' });
    expect(parseCreateKey({ name: 'x', scopes: ['users'], days: 30 })).toMatchObject({ ok: false, message: '읽을 범위가 올바르지 않습니다.' });
    expect(parseCreateKey({ name: 'x', scopes: ['usage'], days: 0 })).toMatchObject({ ok: false });
    expect(parseCreateKey({ name: 'x', scopes: ['usage'], days: 3650 })).toMatchObject({ ok: false });
    expect(parseCreateKey(null)).toMatchObject({ ok: false });
  });
  it('이용통계 기간 — 비우면 최근 30일(오늘 포함), 날짜 꼴·순서·366일', () => {
    expect(parseUsagePeriod(null, null, '2026-11-09')).toEqual({ ok: true, from: '2026-10-11', to: '2026-11-09' });
    expect(parseUsagePeriod('2026-01-01', '2026-12-31', '2026-11-09')).toEqual({ ok: true, from: '2026-01-01', to: '2026-12-31' });
    expect(parseUsagePeriod('2025-01-01', '2026-01-02', '2026-11-09')).toMatchObject({ ok: false });
    expect(parseUsagePeriod('2026-11-10', '2026-11-09', '2026-11-09')).toMatchObject({ ok: false });
    expect(parseUsagePeriod('2026-02-30', null, '2026-11-09')).toMatchObject({ ok: false });
    expect(parseUsagePeriod('20261101', null, '2026-11-09')).toMatchObject({ ok: false });
  });
  it('화면 꼴 — 해시 없음, 만료는 시각으로, 범위는 정해 둔 순서', () => {
    const row = { id: 'k1', name: 'n', token_prefix: 'wo_api_abcde', scopes: ['usage', 'adoption'], status: 'active', expires_at: '2026-11-10T00:00:00Z', revoked_at: null, last_used_at: null, use_count: 3, created_at: '2026-11-01T00:00:00Z', token_hash: 'x'.repeat(64) };
    const v = keyView(row, Date.parse('2026-11-09T00:00:00Z'), '홍길동');
    expect(v).toMatchObject({ status: 'active', scopes: ['adoption', 'usage'], createdByName: '홍길동' });
    expect(v).not.toHaveProperty('token_hash');
    expect(JSON.stringify(v)).not.toContain('x'.repeat(64));
    expect(keyView(row, Date.parse('2026-11-11T00:00:00Z')).status).toBe('expired');
    expect(keyView({ ...row, status: 'revoked', revoked_at: '2026-11-02T00:00:00Z' }, 0).status).toBe('revoked');
  });
  it('화면의 호출 예시', () => {
    expect(curlExample('https://workon-ai.vercel.app', 'wo_api_T')).toBe('curl -H "Authorization: Bearer wo_api_T" "https://workon-ai.vercel.app/api/v1/adoption-report?month=2026-11"');
  });
});

const ORG = 'org-1';
const token = generateOrgApiToken().token;
function deps(over: Partial<OrgApiDeps> = {}) {
  const recordCall = vi.fn(async () => {});
  const d: OrgApiDeps = {
    claim: vi.fn(async (hash: string) => (hash === hashOrgApiToken(token)
      ? { ok: true as const, key: { id: 'k1', organization_id: ORG, created_by: 'u1', scopes: ['adoption'] } }
      : { ok: false as const, reason: 'invalid' as const })),
    loadCreator: vi.fn(async () => ({ id: 'u1', role: 'ADMIN', is_active: true, deleted_at: null, department_id: 'top' })),
    loadDepartment: vi.fn(async () => ({ organization_id: ORG, parent_id: null })),
    allowedIps: vi.fn(async () => null),
    managedDepartmentIds: vi.fn(async () => ['top', 'child']),
    recordCall,
    now: () => Date.parse('2026-11-09T01:00:00Z'),
    ...over,
  };
  return { d, recordCall };
}
const req = (authorization: string | null = `Bearer ${token}`, ip: string | null = '10.0.0.5') => ({ authorization, ip });
const ok = vi.fn(async () => ({ data: { n: 1 } }));

describe('handleOrgApiCall — 호출 확인', () => {
  it('맞는 키·범위·기관 전체 관리자면 그 관리 범위로 세고 200, 호출 기록', async () => {
    const t = deps();
    const run = vi.fn(async (ctx: { departmentIds: string[]; organizationId: string; keyId: string }) => ({ data: ctx }));
    const res = await handleOrgApiCall(t.d, req(), 'adoption-report', run);
    expect(res).toEqual({ status: 200, body: { ok: true, data: { keyId: 'k1', organizationId: ORG, departmentIds: ['top', 'child'] } } });
    expect(t.recordCall).toHaveBeenCalledWith('k1', ORG, 'adoption-report', 200);
  });
  it('키 꼴이 틀리거나 무효면 같은 401, 차지 전에 끊고 기록하지 않는다', async () => {
    const t = deps();
    expect(await handleOrgApiCall(t.d, req(null), 'adoption-report', ok)).toMatchObject({ status: 401, body: { error: { message: ORG_API_INVALID_TOKEN } } });
    expect(t.d.claim).not.toHaveBeenCalled();
    expect(await handleOrgApiCall(t.d, req(`Bearer ${generateOrgApiToken().token}`), 'adoption-report', ok)).toMatchObject({ status: 401, body: { error: { message: ORG_API_INVALID_TOKEN } } });
    expect(t.recordCall).not.toHaveBeenCalled();
    expect(ok).not.toHaveBeenCalled();
  });
  it('하루 상한이면 429를 기록하고 세지 않는다', async () => {
    const t = deps({ claim: async () => ({ ok: false as const, reason: 'daily_limit' as const, key_id: 'k1', organization_id: ORG }) });
    expect(await handleOrgApiCall(t.d, req(), 'usage-summary', ok)).toMatchObject({ status: 429, body: { error: { message: ORG_API_DAILY_LIMITED } } });
    expect(t.recordCall).toHaveBeenCalledWith('k1', ORG, 'usage-summary', 429);
    expect(ok).not.toHaveBeenCalled();
  });
  it('기관 접속 허용 IP 밖이면 403(IP를 모를 때도), 안이면 통과', async () => {
    let t = deps({ allowedIps: async () => ['10.0.0.0/24'] });
    expect((await handleOrgApiCall(t.d, req(undefined, '203.0.113.9'), 'adoption-report', ok)).body).toMatchObject({ error: { message: ORG_API_IP_DENIED } });
    expect(t.recordCall).toHaveBeenCalledWith('k1', ORG, 'adoption-report', 403);
    expect((await handleOrgApiCall(t.d, req(undefined, null), 'adoption-report', ok)).status).toBe(403);
    t = deps({ allowedIps: async () => ['10.0.0.0/24'] });
    expect((await handleOrgApiCall(t.d, req(undefined, '10.0.0.5'), 'adoption-report', ok)).status).toBe(200);
  });
  it('키 범위 밖 끝점은 403(adoption 키로 이용통계)', async () => {
    const t = deps();
    expect(await handleOrgApiCall(t.d, req(), 'usage-summary', ok)).toMatchObject({ status: 403, body: { error: { message: ORG_API_SCOPE_DENIED } } });
    expect(t.recordCall).toHaveBeenCalledWith('k1', ORG, 'usage-summary', 403);
  });
  it('만든 관리자가 비활성·탈퇴·직원이 됨·하위 부서로 옮김·다른 기관·없음이면 403', async () => {
    const cases: Array<Partial<OrgApiDeps>> = [
      { loadCreator: async () => ({ id: 'u1', role: 'ADMIN', is_active: false, deleted_at: null, department_id: 'top' }) },
      { loadCreator: async () => ({ id: 'u1', role: 'ADMIN', is_active: true, deleted_at: '2026-11-08T00:00:00Z', department_id: 'top' }) },
      { loadCreator: async () => ({ id: 'u1', role: 'USER', is_active: true, deleted_at: null, department_id: 'top' }) },
      { loadDepartment: async () => ({ organization_id: ORG, parent_id: 'top' }) },
      { loadDepartment: async () => ({ organization_id: 'other-org', parent_id: null }) },
      { loadCreator: async () => null },
      { managedDepartmentIds: async () => [] },
    ];
    for (const over of cases) {
      const t = deps(over);
      expect(await handleOrgApiCall(t.d, req(), 'adoption-report', ok)).toMatchObject({ status: 403, body: { error: { message: ORG_API_CREATOR_UNAVAILABLE } } });
    }
  });
  it('입력 오류는 그 상태로, 세다가 던지면 500 — 둘 다 기록', async () => {
    let t = deps();
    expect(await handleOrgApiCall(t.d, req(), 'adoption-report', async () => ({ status: 400, message: 'month는…' }))).toMatchObject({ status: 400 });
    expect(t.recordCall).toHaveBeenCalledWith('k1', ORG, 'adoption-report', 400);
    t = deps();
    expect(await handleOrgApiCall(t.d, req(), 'adoption-report', async () => { throw new Error('db'); })).toMatchObject({ status: 500 });
    expect(t.recordCall).toHaveBeenCalledWith('k1', ORG, 'adoption-report', 500);
  });
  it('호출 기록이 실패해도 응답은 그대로', async () => {
    const t = deps({ recordCall: async () => { throw new Error('db'); } });
    expect((await handleOrgApiCall(t.d, req(), 'adoption-report', ok)).status).toBe(200);
  });
});

describe('숫자만', () => {
  it('나만의 비서는 이름 없이, 그 밖은 이름 그대로(아이콘 등 화면 칸 없음)', () => {
    expect(agentNameEntry({ name: '김주무관의 비서', tier: 'personal' })).toEqual({ name: PERSONAL_AGENT_LABEL, sub: '' });
    expect(agentNameEntry({ name: '여비 안내', tier: 'official' })).toEqual({ name: '여비 안내', sub: '' });
  });
  it('직원별 이용통계는 DB를 부르기 전에 400, 모르는 축도 400', async () => {
    const ctx = { keyId: 'k', organizationId: ORG, departmentIds: ['d'] };
    expect(await usageSummary(ctx, { by: 'user', from: null, to: null })).toEqual({ status: 400, message: USAGE_USER_AXIS_DENIED });
    expect(await usageSummary(ctx, { by: 'model', from: null, to: null })).toMatchObject({ status: 400 });
    expect(await usageSummary(ctx, { by: 'agent', from: '2026-13-01', to: null })).toMatchObject({ status: 400 });
  });
});

describe('관리·라우트 (원본)', () => {
  const actor = (over: Partial<ActorScope>): ActorScope => ({ userId: 'u', isAdmin: true, departmentId: 'top', organizationId: ORG, visibleDepartmentIds: [], managedDepartmentIds: ['top'], managesWholeOrganization: true, ...over });
  it('키 관리는 기관 전체 관리자만', () => {
    expect(wholeOrgAdminProblem(actor({}))).toBeNull();
    expect(wholeOrgAdminProblem(actor({ managesWholeOrganization: false }))).toMatchObject({ status: 403 });
    expect(wholeOrgAdminProblem(actor({ isAdmin: false }))).toMatchObject({ status: 403 });
    expect(wholeOrgAdminProblem(null)).toMatchObject({ status: 403 });
  });
  it('API 라우트 셋은 같은 확인(handleOrgApiCall)을 거치고 캐시하지 않는다', () => {
    for (const [f, endpoint] of [
      ['src/app/api/v1/adoption-report/route.ts', 'adoption-report'],
      ['src/app/api/v1/adoption-report/departments/route.ts', 'adoption-departments'],
      ['src/app/api/v1/usage-summary/route.ts', 'usage-summary'],
    ]) {
      const src = readFileSync(f, 'utf8');
      expect(src).toContain('handleOrgApiCall(orgApiDeps()');
      expect(src).toContain(`'${endpoint}'`);
      expect(src).toContain("'Cache-Control': 'no-store'");
      expect(src).toContain('clientIpFrom(request.headers, request.ip)');
    }
  });
  it('관리 라우트 — 관리자 확인, 대리 접근은 만들 수 없음, 키 원문은 만든 응답에만', () => {
    const list = readFileSync('src/app/api/admin/api-keys/route.ts', 'utf8');
    expect(list.match(/isAdminSession\(session\)/g)).toHaveLength(2);
    expect(list).toContain('isImpersonating');
    expect(readFileSync('src/app/api/admin/api-keys/[id]/route.ts', 'utf8')).toContain('isAdminSession(session)');
    const admin = readFileSync('src/lib/org-api/admin.ts', 'utf8');
    expect(admin).toContain("'org_api_key_created'");
    expect(admin).toContain("'org_api_key_revoked'");
    // 목록·보안 기록에 해시를 싣지 않는다
    expect(admin).not.toMatch(/KEY_COLUMNS = '[^']*token_hash/);
    expect(admin).not.toMatch(/logSecurityEvent\([^)]*token_hash/);
  });
  it('화면은 기관 정보 화면에 있고, 규칙은 잎 파일(spec)만 가져온다', () => {
    expect(readFileSync('src/app/admin/organization/page.tsx', 'utf8')).toContain('<OrgApiKeysPanel />');
    const panel = readFileSync('src/components/admin/OrgApiKeysPanel.tsx', 'utf8');
    expect(panel).toContain("from '@/lib/org-api/spec'");
    expect(panel).not.toMatch(/from '@\/lib\/org-api\/(keys|admin|reports)'/);
    expect(readFileSync('src/lib/org-api/spec.ts', 'utf8')).not.toMatch(/^import /m);
  });
  it('마이그레이션 0075 — 추가만·RLS·실행 권한 service_role만', () => {
    const sql = readFileSync('supabase/migrations/0075_org_api_keys.sql', 'utf8');
    expect(sql).toContain('CREATE TABLE IF NOT EXISTS public.org_api_keys');
    expect(sql).toContain('ALTER TABLE public.org_api_keys ENABLE ROW LEVEL SECURITY');
    expect(sql).toContain('ALTER TABLE public.org_api_key_calls ENABLE ROW LEVEL SECURITY');
    expect(sql).toContain('GRANT EXECUTE ON FUNCTION public.org_api_key_claim(text, timestamptz, integer) TO service_role');
    expect(sql).not.toMatch(/DROP |ALTER TABLE public\.(?!org_api)/);
  });
});
