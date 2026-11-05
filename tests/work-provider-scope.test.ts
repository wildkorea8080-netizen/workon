import { beforeEach, describe, expect, it, vi } from 'vitest';
const state = vi.hoisted(() => ({ org: 'org', visible: ['dept'], agents: [] as Record<string, unknown>[], docs: [] as Record<string, unknown>[], queries: [] as unknown[], sources: [] as unknown[], error: false, searches: [] as Record<string, unknown>[], context: '' }));
vi.mock('@/lib/config', async (original) => ({ ...await original<typeof import('@/lib/config')>(), NODA_API_KEY: 'test-only' }));
vi.mock('@/lib/department-scope', () => ({ getAccessScope: async () => ({ organizationId: state.org, visibleDepartmentIds: state.visible }) }));
vi.mock('@/lib/logger', () => ({ logSystem: async () => {} }));
vi.mock('@/lib/noda', async (original) => ({ ...await original<typeof import('@/lib/noda')>(), noda: { getContext: async (args: Record<string, unknown>) => { state.searches.push(args); return { sources: state.sources, context: state.context }; } } }));
vi.mock('@/lib/supabaseAdmin', () => ({ supabaseAdmin: { from(table: string) {
  let rows = table === 'agents' ? state.agents : state.docs;
  const q = { select: () => q, eq: (col: string, value: unknown) => { rows = rows.filter((r) => r[col] === value); return q; }, is: (col: string, value: unknown) => { rows = rows.filter((r) => r[col] === value); return q; }, in: (col: string, ids: unknown[]) => { state.queries.push([table, col, ids]); rows = rows.filter((r) => ids.includes(r[col])); return q; }, order: () => q, limit: () => q, range: () => q, then: (resolve: (v: unknown) => unknown, reject: (e: unknown) => unknown) => Promise.resolve({ data: rows, error: state.error ? { message: 'test' } : null }).then(resolve, reject) }; return q;
} } }));
import { defaultRegulationProviders } from '@/lib/work/workflows/regulations/providers';
import { nodaTenant, nodaFilename } from '@/lib/noda';
const chosen = '11111111-1111-4111-8111-111111111111';
const other = '22222222-2222-4222-8222-222222222222';
const doc = '33333333-3333-4333-8333-333333333333';
const scope = { organizationId: 'org', organizationName: '기관', departmentId: 'dept', agentId: chosen };
beforeEach(() => {
  const agent = { id: chosen, organization_id: 'org', tier: 'official', is_published: true, is_active: true, deleted_at: null, visibility: 'organization', department_id: 'dept', capabilities: { doc_search: {} } };
  state.org = 'org'; state.visible = ['dept']; state.error = false; state.queries = []; state.searches = []; state.sources = []; state.context = '';
  state.agents = [agent, { ...agent, id: other }];
  state.docs = [{ id: doc, agent_id: chosen, organization_id: 'org', department_id: 'dept', visibility: 'organization', title: '문서', file_name: '문서.txt', noda_status: 'ready' }];
});
describe('운영 기관 문서 제공자의 범위(DB·NODA만 대체)', () => {
  it('선택 문서함 하나만 검색하고 문서 행 조회도 그 비서에 제한한다', async () => {
    await defaultRegulationProviders.orgDocuments(scope, '질문');
    expect(state.searches).toEqual([expect.objectContaining({ tenant: nodaTenant(chosen), query: '질문' })]);
    expect(state.queries).toContainEqual(['documents', 'agent_id', [chosen]]);
  });
  it('부서 소속 기관이 다르면 검색을 호출하지 않는다', async () => {
    state.org = 'other-org';
    await expect(defaultRegulationProviders.orgDocuments(scope, '질문')).rejects.toThrow('organization mismatch');
    expect(state.searches).toHaveLength(0);
  });
  it.each([{ is_active: false }, { is_published: false }, { deleted_at: '2026-10-29' }, { organization_id: 'other' }, { visibility: 'department', department_id: 'other' }, { capabilities: {} }])('현재 접근 불가면 다른 비서로 대체하지 않는다: %j', async (patch) => {
    state.agents[0] = { ...state.agents[0], ...patch };
    await expect(defaultRegulationProviders.orgDocuments(scope, '질문')).rejects.toThrow();
    expect(state.searches).toHaveLength(0);
  });
  it('공개 비서라도 권한 밖 부서 문서는 검색하지 않는다', async () => {
    state.docs[0] = { ...state.docs[0], visibility: 'department', department_id: 'other' };
    await expect(defaultRegulationProviders.orgDocuments(scope, '질문')).rejects.toThrow();
    expect(state.searches).toHaveLength(0);
  });
  it('준비된 문서가 없으면 조회하지 않는다', async () => {
    state.docs[0].noda_status = 'pending';
    await expect(defaultRegulationProviders.orgDocuments(scope, '질문')).rejects.toThrow();
    expect(state.searches).toHaveLength(0);
  });
  it('다른 문서 ID의 근거가 반환되면 결과를 사용하지 않는다', async () => {
    state.sources = [{ filename: nodaFilename(other, '다른문서.txt'), text: '다른 자료', citation: 1 }];
    await expect(defaultRegulationProviders.orgDocuments(scope, '질문')).rejects.toThrow('mismatch');
  });
  it('DB 오류는 NODA 호출 전에 실패한다', async () => {
    state.error = true;
    await expect(defaultRegulationProviders.orgDocuments(scope, '질문')).rejects.toThrow();
    expect(state.searches).toHaveLength(0);
  });
});

describe('적용 기준일로 판 고르기(2026-11-05)', () => {
  const oldDoc = '44444444-4444-4444-8444-444444444444';
  const newDoc = '55555555-5555-4555-8555-555555555555';
  beforeEach(() => {
    const base = { agent_id: chosen, organization_id: 'org', department_id: 'dept', visibility: 'organization', noda_status: 'ready' };
    state.docs = [
      { ...base, id: oldDoc, title: '여비 규정(현행)', file_name: '여비.txt', replaces_id: null, effective_from: null },
      // 시행일을 먼 미래로 예약한 새 판 — 오늘은 옛 판이 근거
      { ...base, id: newDoc, title: '여비 규정(개정)', file_name: '여비2.txt', replaces_id: oldDoc, effective_from: '2099-01-01' },
    ];
    state.sources = [
      { n: 1, filename: nodaFilename(oldDoc, '여비.txt') },
      { n: 2, filename: nodaFilename(newDoc, '여비2.txt') },
    ];
    state.context = ['[1] 여비 규정(현행)', '일비 20,000원', '[2] 여비 규정(개정)', '일비 25,000원'].join(String.fromCharCode(10));
  });
  const ids = async (s: typeof scope & { basisDate?: string }) => {
    const r = await defaultRegulationProviders.orgDocuments(s, '일비');
    return r.status === 'ok' ? r.items.map((e) => e.documentId) : r;
  };

  it('기준일이 없거나 오늘·과거면 오늘 시행 중인 옛 판이 근거', async () => {
    expect(await ids(scope)).toEqual([oldDoc]);
    expect(await ids({ ...scope, basisDate: '2020-01-01' })).toEqual([oldDoc]);
  });

  it('기준일이 새 판 시행일 뒤면 그날 시행될 새 판이 근거(시행일도 실림)', async () => {
    expect(await ids({ ...scope, basisDate: '2099-01-01' })).toEqual([newDoc]);
    const r = await defaultRegulationProviders.orgDocuments({ ...scope, basisDate: '2099-06-30' }, '일비');
    expect(r.status === 'ok' && r.items[0]).toMatchObject({ documentId: newDoc, effectiveDate: '2099-01-01' });
  });

  it('미래지만 새 판 시행일 전이면 여전히 옛 판', async () => {
    expect(await ids({ ...scope, basisDate: '2098-12-31' })).toEqual([oldDoc]);
  });
});
