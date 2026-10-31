import { describe, expect, it, vi } from 'vitest';
import { appEvidenceSources, retrieveAppEvidence, storedAppEvidence } from '@/lib/work/app-evidence';
import type { WorkContext } from '@/lib/work/context';
import type { WorkTaskRow } from '@/lib/work/types';
import type { RawEvidence } from '@/lib/work/workflows/regulations/evidence';
const evidence: RawEvidence = { kind: 'org_doc', title: '규정', location: 'p.3', text: '출장비 지급 기준', effectiveDate: null, editionYear: null, issuer: null, url: null };
const task = { organization_id: 'org', department_id: 'dept', app_snapshot: { agentId: 'chosen', documentScope: 'selected-agent' } } as WorkTaskRow;
function context(result: unknown) {
  const orgDocuments = vi.fn(async () => result);
  const ctx = { store: { getOrganizationName: async () => '기관' }, regulations: { providers: { orgDocuments } } } as unknown as WorkContext;
  return { ctx, orgDocuments };
}
describe('보고서·회신 문서함 근거', () => {
  it('선택한 문서함 하나만 조회하고 출처 위치를 보존한다', async () => {
    const { ctx, orgDocuments } = context({ status: 'ok', items: [evidence] });
    const result = await retrieveAppEvidence(ctx, task, '출장');
    expect(orgDocuments).toHaveBeenCalledWith(expect.objectContaining({ organizationId: 'org', departmentId: 'dept', agentId: 'chosen' }), '출장');
    expect(result.sources[0]).toMatchObject({ name: '규정 · p.3', text: evidence.text });
    expect(result.sources[0].id).toMatch(/^rag:/);
  });
  it('연결하지 않은 기존 작업은 검색을 호출하지 않는다', async () => {
    const { ctx, orgDocuments } = context(null);
    expect(await retrieveAppEvidence(ctx, { ...task, app_snapshot: null }, '문의')).toEqual({ sources: [] });
    expect(orgDocuments).not.toHaveBeenCalled();
  });
  it.each([{ status: 'unavailable' }, { status: 'ok', items: [] }])('사용할 수 없거나 근거가 없으면 생성 전에 실패한다', async (result) => {
    await expect(retrieveAppEvidence(context(result).ctx, task, '문의')).rejects.toMatchObject({ code: 'SOURCE_UNAVAILABLE' });
  });
  it('본문 길이·개수를 제한하고 저장한 근거를 재사용한다', () => {
    const rows = appEvidenceSources(Array.from({ length: 30 }, (_, i) => ({ ...evidence, title: String(i), text: 'a'.repeat(2000) })));
    expect(rows).toHaveLength(24);
    expect(rows[0].text).toHaveLength(1500);
    expect(storedAppEvidence({ appEvidence: rows })).toEqual(rows);
    expect(storedAppEvidence({ appEvidence: [null, { id: 'file', text: 'invalid' }] })).toEqual([]);
  });
});

it('원문 ID만 보존하고 주소·저장 경로는 응답에 섞지 않는다', () => {
  const documentId = '33333333-3333-4333-8333-333333333333';
  const rows = appEvidenceSources([{ ...evidence, documentId }]);
  expect(rows[0].documentId).toBe(documentId);
  expect(storedAppEvidence({ appEvidence: [{ ...rows[0], storage_path: 'secret', url: 'https://example.com' }] })[0]).toEqual(rows[0]);
  expect(appEvidenceSources([{ ...evidence, documentId: 'invalid' }])[0].documentId).toBeUndefined();
});
