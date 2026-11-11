import { readFileSync } from 'fs';
import { describe, expect, it, vi } from 'vitest';
import type { ActorScope } from '@/lib/agent-permissions';
import { commonDocumentCitedBy, type CommonCitedByDeps, type ReferenceDocumentRow } from '@/lib/document-references';
import { citedByNote } from '@/components/admin/CommonLibraryPanel';

/** 2026-11-12 — 공통 기준 문서를 인용하는 기관 문서(관리자 문서 화면 '공통 기준 문서'의 '인용하는 문서') */

const actor: ActorScope = {
  userId: 'u1', isAdmin: true, departmentId: 'dep1', organizationId: 'org1', visibleDepartmentIds: ['dep1'], managedDepartmentIds: ['dep1'], managesWholeOrganization: false,
};
const COMMON = '11111111-1111-4111-8111-111111111111';
const docRow = (over: Partial<ReferenceDocumentRow> = {}): ReferenceDocumentRow => ({
  id: 'doc1', agent_id: 'ag1', department_id: 'dep1', organization_id: 'org1', visibility: 'organization', storage_path: 'p/doc1.hwpx', file_name: '출장 지침.hwpx',
  title: null, noda_status: 'ready', retired_at: null, effective_from: null, agent: { name: '총무 비서', deleted_at: null }, ...over,
});

function deps(over: Partial<CommonCitedByDeps> = {}) {
  const d: CommonCitedByDeps = {
    loadCommon: vi.fn(async () => ({ id: COMMON, org_type: '지방자치단체', title: '예산편성기준', file_name: '2026 예산편성기준.pdf', edition_year: 2026 })),
    orgType: vi.fn(async () => '지방자치단체'),
    listCiting: vi.fn(async () => [
      docRow({ id: 'a', file_name: '세출 예산 지침.hwpx' }),
      docRow({ id: 'b', visibility: 'department', department_id: 'dep9' }),
      docRow({ id: 'c', agent: { name: '옛 비서', deleted_at: '2026-01-01' } }),
      docRow({ id: 'd', noda_status: 'retired', retired_at: 't', title: '옛 세출 지침' }),
      docRow({ id: 'e', noda_status: 'deleting' }),
    ]),
    coverage: vi.fn(async () => ({ indexed: 7, total: 9 })),
    ...over,
  };
  return d;
}

describe('공통 기준 문서를 인용하는 기관 문서', () => {
  it('이 기관 유형의 문서 이름 열쇠로 찾고, 볼 수 있는 문서만(남의 부서 전용·지운 비서·지우는 중 제외), 지금 판 먼저', async () => {
    const d = deps();
    const out = await commonDocumentCitedBy(COMMON.toUpperCase(), actor, d);
    expect(d.loadCommon).toHaveBeenCalledWith(COMMON);
    expect(d.listCiting).toHaveBeenCalledWith('org1', ['예산편성기준']);
    expect(out).toEqual({ ok: true, data: {
      document: { id: COMMON, name: '예산편성기준', editionYear: 2026 },
      citedBy: [
        { id: 'a', name: '세출 예산 지침.hwpx', agentName: '총무 비서', status: 'current', effectiveFrom: null },
        { id: 'd', name: '옛 세출 지침', agentName: '총무 비서', status: 'retired', effectiveFrom: null },
      ],
      coverage: { indexed: 7, total: 9 },
    } });
  });
  it('다른 유형·없는 문서·유형 없는 기관은 같은 404(인용 목록을 읽지 않음), 기관 없는 요청은 403', async () => {
    for (const over of [{ orgType: vi.fn(async () => '공공기관') }, { loadCommon: vi.fn(async () => null) }, { orgType: vi.fn(async () => null) }] as Partial<CommonCitedByDeps>[]) {
      const d = deps(over);
      expect(await commonDocumentCitedBy(COMMON, actor, d)).toEqual({ ok: false, status: 404, message: '문서를 찾을 수 없습니다.' });
      expect(d.listCiting).not.toHaveBeenCalled();
    }
    expect(await commonDocumentCitedBy(COMMON, { ...actor, organizationId: null }, deps())).toMatchObject({ ok: false, status: 403 });
  });
  it('색인 범위를 못 세도 목록은 돌려준다', async () => {
    const out = await commonDocumentCitedBy(COMMON, actor, deps({ coverage: vi.fn(async () => { throw new Error('db'); }) }));
    expect(out).toMatchObject({ ok: true, data: { coverage: null } });
  });
  it('안내 글 — 색인이 덜 됐으면 빠질 수 있음을 함께', () => {
    expect(citedByNote(2, { indexed: 7, total: 9 })).toBe('이 기준을 「」로 인용한 기관 문서 2개 — 아직 색인하지 않은 문서 2개는 빠져 있을 수 있습니다(5분마다 채워집니다).');
    expect(citedByNote(0, { indexed: 9, total: 9 })).toBe('이 기준을 「」로 인용한 기관 문서를 찾지 못했습니다');
    expect(citedByNote(1, null)).toBe('이 기준을 「」로 인용한 기관 문서 1개');
  });
  it('연결(원본) — 관리자 검사·이 기관 유형·화면 단추', () => {
    const route = readFileSync('src/app/api/admin/common-documents/[id]/cited-by/route.ts', 'utf8');
    expect(route).toContain('if (!isAdminSession(session)) return jsonError');
    expect(route).toContain('commonDocumentCitedBy(params.id, actor, {');
    const panel = readFileSync('src/components/admin/CommonLibraryPanel.tsx', 'utf8');
    expect(panel).toContain('fetch(`/api/admin/common-documents/${encodeURIComponent(id)}/cited-by`)');
    expect(panel).toContain("import type { CitingDocument } from '@/lib/document-references';");
  });
});
