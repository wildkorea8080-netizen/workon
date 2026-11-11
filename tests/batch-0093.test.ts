import { readFileSync } from 'fs';
import { describe, expect, it, vi } from 'vitest';
import type { ActorScope } from '@/lib/agent-permissions';
import {
  buildCitedBy, commonDocumentCitedBy, documentReferences, referenceKey, similarCitation,
  type CommonCitedByDeps, type ReferenceDeps, type ReferenceDocumentRow,
} from '@/lib/document-references';

/** 2026-11-12 — 거꾸로 목록의 '이름 비슷'(같은 이름이 아니어도 한쪽이 다른 쪽을 품는 인용) */

const actor: ActorScope = {
  userId: 'u1', isAdmin: true, departmentId: 'dep1', organizationId: 'org1', visibleDepartmentIds: ['dep1'], managedDepartmentIds: ['dep1'], managesWholeOrganization: false,
};
const docRow = (over: Partial<ReferenceDocumentRow> = {}): ReferenceDocumentRow => ({
  id: 'doc1', agent_id: 'ag1', department_id: 'dep1', organization_id: 'org1', visibility: 'organization', storage_path: 'p/doc1.hwpx', file_name: '출장 지침.hwpx',
  title: null, noda_status: 'ready', retired_at: null, effective_from: null, agent: { name: '총무 비서', deleted_at: null }, ...over,
});

describe('이름 비슷 규칙', () => {
  it('한쪽이 다른 쪽을 품고 둘 다 4자 이상일 때만, 같은 이름은 비슷이 아님', () => {
    const self = [referenceKey('예산편성기준')];
    expect(similarCitation([referenceKey('지방공기업 예산편성기준')], self)).toBe(true);
    expect(similarCitation([referenceKey('2026년도 예산편성기준')], self)).toBe(false); // 같은 이름(연도 뗌) — 같은 이름 쪽
    expect(similarCitation([referenceKey('예산')], self)).toBe(false); // 짧은 이름
    expect(similarCitation([referenceKey('회계기준')], self)).toBe(false);
    expect(similarCitation([], self)).toBe(false);
    expect(similarCitation([referenceKey('편성기준')], self)).toBe(true); // 이 문서 이름이 인용을 품음
  });
  it('목록 — 같은 이름 먼저, 비슷한 것은 표시', () => {
    const out = buildCitedBy(actor, [docRow({ id: 'a', file_name: '가 지침.hwpx' }), docRow({ id: 'b', file_name: '나 지침.hwpx' })], 'self', new Set(['a']));
    expect(out.map((d) => [d.id, d.similar ?? false])).toEqual([['b', false], ['a', true]]);
  });
});

describe('문서 참조 창의 거꾸로 목록', () => {
  const deps = (over: Partial<ReferenceDeps> = {}): ReferenceDeps => ({
    loadDocument: vi.fn(async () => docRow({ id: 'self', file_name: '예산편성기준.hwpx' })),
    readText: vi.fn(async () => ({ ok: true as const, text: '본문', truncated: false })),
    listDocuments: vi.fn(async () => ({ rows: [], truncated: false })),
    listCommon: vi.fn(async () => []),
    saveIndex: vi.fn(async () => true),
    listCiting: vi.fn(async () => [docRow({ id: 'a', file_name: '세출 지침.hwpx' })]),
    listSimilarCiting: vi.fn(async () => [docRow({ id: 'a', file_name: '세출 지침.hwpx' }), docRow({ id: 'b', file_name: '공사 예산 지침.hwpx' })]),
    coverage: vi.fn(async () => ({ indexed: 3, total: 3 })),
    ...over,
  });
  it('같은 이름에 이미 있으면 같은 이름으로, 나머지는 이름 비슷', async () => {
    const d = deps();
    const out = await documentReferences('self', actor, d);
    expect(d.listSimilarCiting).toHaveBeenCalledWith('org1', ['예산편성기준']);
    if (!out.ok) throw new Error('fail');
    expect(out.data.citedBy.map((c) => [c.id, c.similar ?? false])).toEqual([['a', false], ['b', true]]);
  });
  it('비슷한 쪽을 못 읽거나 없으면 같은 이름만(예전과 같음)', async () => {
    const thrown = await documentReferences('self', actor, deps({ listSimilarCiting: vi.fn(async () => { throw new Error('db'); }) }));
    expect(thrown.ok && thrown.data.citedBy.map((c) => c.id)).toEqual(['a']);
    const none = await documentReferences('self', actor, deps({ listSimilarCiting: undefined }));
    expect(none.ok && none.data.citedBy.map((c) => c.id)).toEqual(['a']);
  });
});

describe('공통 기준 문서의 인용하는 문서', () => {
  it('「지방공기업 예산편성기준」처럼 앞에 말이 붙은 인용도 이름 비슷으로', async () => {
    const d: CommonCitedByDeps = {
      loadCommon: vi.fn(async () => ({ id: '11111111-1111-4111-8111-111111111111', org_type: '지방공기업', title: '예산편성기준', file_name: 'x.pdf', edition_year: 2026 })),
      orgType: vi.fn(async () => '지방공기업'),
      listCiting: vi.fn(async () => []),
      listSimilarCiting: vi.fn(async () => [docRow({ id: 'c', file_name: '공사 예산 운영지침.hwpx' })]),
      coverage: vi.fn(async () => null),
    };
    const out = await commonDocumentCitedBy('11111111-1111-4111-8111-111111111111', actor, d);
    expect(out.ok && out.data.citedBy).toEqual([{ id: 'c', name: '공사 예산 운영지침.hwpx', agentName: '총무 비서', status: 'current', effectiveFrom: null, similar: true }]);
  });
  it('연결(원본) — DB는 색인 열쇠만 쪽마다 읽어 앱에서 가리고, 두 화면이 이름 비슷을 표시', () => {
    const db = readFileSync('src/lib/document-references-db.ts', 'utf8');
    expect(db).toContain(".select('id, keys:metadata->references->keys', withCount ? { count: 'exact' } : undefined)");
    expect(db).toContain(".eq('metadata->references->>status', 'ok')");
    expect(db).toContain('similarCitation((r.keys as unknown[]).filter((k): k is string => typeof k === \'string\'), keys)');
    expect(readFileSync('src/app/api/admin/common-documents/[id]/cited-by/route.ts', 'utf8')).toContain('listSimilarCiting: refs.listSimilarCiting,');
    expect(readFileSync('src/components/admin/DocumentReferencesModal.tsx', 'utf8')).toContain('{d.similar ? <span');
    expect(readFileSync('src/components/admin/CommonLibraryPanel.tsx', 'utf8')).toContain('{c.similar ? <span');
  });
});
