import { describe, expect, it, vi } from 'vitest';
import { restrictDocumentAgents } from '@/lib/work/workflows/regulations/scope';
import { gatherEvidence, type RegulationProviders } from '@/lib/work/workflows/regulations/gather';
import type { RegulationPlan } from '@/lib/work/workflows/regulations/model';

const plan = { searchQuery: '출장', lawQueries: [], keywords: ['출장'] } as RegulationPlan;
const scope = { organizationId: 'org', organizationName: '기관', departmentId: 'dept', agentId: 'chosen' };
describe('규정 업무의 선택 문서함 범위', () => {
  it('선택하지 않으면 기존 범위를 유지하고 선택하면 한 곳만 반환한다', () => {
    const eligible = [{ id: 'other' }, { id: 'chosen' }];
    expect(restrictDocumentAgents(eligible)).toEqual(eligible);
    expect(restrictDocumentAgents(eligible, 'chosen')).toEqual([{ id: 'chosen' }]);
  });
  it('선택한 비서가 현재 허용 목록에 없으면 다른 자료로 대체하지 않는다', () => {
    expect(() => restrictDocumentAgents([{ id: 'other' }], 'chosen')).toThrow('no longer available');
    expect(() => restrictDocumentAgents([], 'chosen')).toThrow();
  });
  it('선택 범위는 기관 문서에 전달되며 공통·법령도 함께 조회한다', async () => {
    const providers: RegulationProviders = { orgDocuments: vi.fn(async () => ({ status: 'ok' as const, items: [] })), common: vi.fn(async () => ({ status: 'ok' as const, items: [] })), laws: vi.fn(async () => ({ status: 'ok' as const, items: [] })) };
    const result = await gatherEvidence(providers, scope, plan, [{ id: 'upload', name: '첨부', text: '자료' }]);
    expect(providers.orgDocuments).toHaveBeenCalledWith(scope, '출장');
    expect(providers.common).toHaveBeenCalledTimes(1);
    expect(providers.laws).toHaveBeenCalledTimes(1);
    expect(result.raw).toMatchObject([{ kind: 'upload', title: '첨부' }]);
  });
  it('선택 문서함이 사라지면 부분 결과를 완료 처리하지 않는다', async () => {
    const providers: RegulationProviders = { orgDocuments: async () => { restrictDocumentAgents([], scope.agentId); return { status: 'ok' as const, items: [] }; }, common: async () => ({ status: 'ok' as const, items: [] }), laws: async () => ({ status: 'ok' as const, items: [] }) };
    await expect(gatherEvidence(providers, scope, plan, [])).rejects.toMatchObject({ code: 'SOURCE_UNAVAILABLE' });
  });
});
