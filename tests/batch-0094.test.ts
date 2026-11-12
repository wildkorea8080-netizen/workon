import { readFileSync } from 'fs';
import { describe, expect, it } from 'vitest';
import { countCitations, referenceKey, type CitationCountRow } from '@/lib/document-references';
import { citedOrgSummary } from '@/lib/common-citations';

/** 2026-11-12 — 슈퍼관리자 공통 자료실의 '인용 기관'(기관마다 문서 수만) */

const orgs = [{ id: 'o1', name: '가 공사' }, { id: 'o2', name: '나 공단' }, { id: 'o3', name: '다 공사' }];
const row = (id: string, org: string | null, over: Partial<CitationCountRow> = {}): CitationCountRow => ({ id, organization_id: org, noda_status: 'ready', agent: { deleted_at: null }, ...over });
const self = [referenceKey('예산편성기준')];

describe('인용 기관 세기', () => {
  it('같은 이름은 열쇠가 여럿이어도 문서 하나로, 이름 비슷은 같은 이름에 없는 문서만, 많은 순', () => {
    const out = countCitations(orgs, [row('a', 'o1'), row('a', 'o1'), row('b', 'o2')], [
      row('a', 'o1', { keys: [referenceKey('지방공기업 예산편성기준')] }),
      row('c', 'o1', { keys: [referenceKey('지방공기업 예산편성기준')] }),
      row('d', 'o2', { keys: [referenceKey('회계기준')] }),
    ], self);
    expect(out).toEqual([
      { organizationId: 'o1', name: '가 공사', exact: 1, similar: 1 },
      { organizationId: 'o2', name: '나 공단', exact: 1, similar: 0 },
    ]);
  });
  it('그 유형 밖 기관·기관 없음·지우는 중·지운 비서 문서는 세지 않는다', () => {
    const out = countCitations(orgs, [
      row('x', 'o9'), row('y', null), row('z', 'o1', { noda_status: 'deleting' }), row('w', 'o1', { agent: [{ deleted_at: '2026-01-01' }] }),
    ], [row('v', 'o3', { keys: 'not-array' })], self);
    expect(out).toEqual([]);
  });
  it('요약 글', () => {
    expect(citedOrgSummary({ orgCount: 0, organizations: [] })).toBe('이 유형의 기관이 없습니다.');
    expect(citedOrgSummary({ orgCount: 3, organizations: [] })).toContain('3곳 중 이 기준을');
    expect(citedOrgSummary({ orgCount: 3, organizations: [{ organizationId: 'o1', name: 'a', exact: 2, similar: 1 }] })).toBe('이 유형 기관 3곳 중 1곳의 문서 3개가 이 기준을 인용합니다(색인한 문서 안에서).');
  });
  it('연결(원본) — 슈퍼관리자만, 문서 이름을 읽지 않음, 그 유형의 기관만, 화면은 잎 파일만 가져옴', () => {
    const route = readFileSync('src/app/api/super/common-documents/[id]/cited-by/route.ts', 'utf8');
    expect(route).toContain('const admin = getSuperAdminFromRequest(request);');
    const db = readFileSync('src/lib/document-references-db.ts', 'utf8');
    const fn = db.slice(db.indexOf('export async function commonCitationCounts'), db.indexOf('/** 5분 실행기의 색인 자동 채우기'));
    expect(fn).toContain(".from('organizations').select('id, name').eq('type', d.org_type)");
    expect(fn).toContain("const COLUMNS = 'id, organization_id, noda_status, agent:agents(deleted_at)';");
    expect(fn).not.toMatch(/file_name, title|REFERENCE_DOCUMENT_COLUMNS/);
    const page = readFileSync('src/app/super/common-library/page.tsx', 'utf8');
    expect(page).toContain("import { citedOrgSummary, type CitedOrgCounts } from '@/lib/common-citations';");
    expect(page).toContain('fetch(`/api/super/common-documents/${encodeURIComponent(id)}/cited-by`');
    expect(readFileSync('src/lib/common-citations.ts', 'utf8')).not.toMatch(/^import /m);
  });
});
