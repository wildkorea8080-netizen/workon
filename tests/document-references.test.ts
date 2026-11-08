import { readFileSync } from 'fs';
import { describe, expect, it, vi } from 'vitest';
import type { ActorScope } from '@/lib/agent-permissions';
import {
  REFERENCE_MAX_CITATIONS, REFERENCE_MAX_MATCHES, buildCandidates, candidateKeys, candidateStatus, documentReferences, extractCitations, isLawLike,
  matchReferences, referenceKey, summarizeReferences, type ReferenceCandidate, type ReferenceDeps, type ReferenceDocumentRow,
} from '@/lib/document-references';
import { referenceVerdict } from '@/components/admin/DocumentReferencesModal';

/** 문서 참조 관계(2026-11-08) — 「」·『』로 인용한 이름을 문서함과 맞춘다(모델 없음) */

describe('인용 이름 찾기', () => {
  it('「」·『』 안의 이름을 나온 순서로, 같은 이름(띄어쓰기만 다름)은 횟수로, 앞뒤 글과 함께', () => {
    const text = '이 지침은 「여비 규정」 제3조에 따른다.\n출장비는 『공무원 여비 규정』과 「여비규정」을 따른다. 「가」 「123」 「 」';
    const c = extractCitations(text);
    expect(c.map((x) => [x.name, x.count])).toEqual([['여비 규정', 2], ['공무원 여비 규정', 1]]);
    expect(c[0].context).toBe('…이 지침은 「여비 규정」 제3조에 따른다. 출장비는 『공무원 여비 규정』과 「…');
  });
  it('너무 긴 이름은 빼고, 상한까지', () => {
    expect(extractCitations(`「${'가'.repeat(61)}」`)).toEqual([]);
    const many = Array.from({ length: REFERENCE_MAX_CITATIONS + 5 }, (_, i) => `「규정${i}호」`).join(' ');
    expect(extractCitations(many)).toHaveLength(REFERENCE_MAX_CITATIONS);
  });
});

describe('이름 열쇠', () => {
  it('확장자·괄호·앞뒤 연도·개정 꼬리·공백·가운뎃점을 빼고 맞춘다', () => {
    expect(referenceKey('여비 규정(2026 개정).hwpx')).toBe('여비규정');
    expect(referenceKey('2026년도 예산편성기준')).toBe('예산편성기준');
    expect(referenceKey('복무·근태 지침 개정안')).toBe('복무근태지침');
    // '…안'으로 끝나는 낱말은 그대로 — '정보보안'이 '정보보'가 되지 않게
    expect(referenceKey('정보보안 지침')).toBe('정보보안지침');
    expect(referenceKey('정보보안')).toBe('정보보안');
    expect(candidateKeys('여비 규정', '여비규정.hwpx', null)).toEqual(['여비규정']);
  });
  it('법령 꼴 — …법·법률·시행령·시행규칙·조례(기관 내부 규칙은 아님)', () => {
    expect(['지방공기업법', '공무원 여비 규정 시행규칙', '서울특별시 도시계획 조례', '지방공기업법 시행령'].every(isLawLike)).toBe(true);
    expect(['회계 규칙', '여비 규정', '복무 지침'].some(isLawLike)).toBe(false);
  });
});

const cand = (over: Partial<ReferenceCandidate> & { name: string }): ReferenceCandidate => ({
  kind: 'agent', id: over.name, keys: candidateKeys(over.name), status: 'current', ...over,
});

describe('맞추기', () => {
  it('같은 이름 먼저·지금 판 먼저, 짧은 이름은 부분 일치 안 함, 자기 자신은 빼고, 상한까지', () => {
    const rows = matchReferences(extractCitations('「여비 규정」 「규정」 「회계 규칙」'), [
      cand({ name: '여비 규정 해설서', status: 'current' }),
      cand({ name: '여비 규정', status: 'retired', id: 'old' }),
      cand({ name: '여비규정', status: 'current', id: 'self' }),
      cand({ name: '여비 규정.hwpx', status: 'current', id: 'new' }),
      cand({ name: '규정 모음', status: 'current' }),
    ], 'self');
    expect(rows[0].matches.map((m) => [m.id, m.exact])).toEqual([['new', true], ['old', true], ['여비 규정 해설서', false]]);
    expect(rows[0].retiredOnly).toBe(false);
    expect(rows[1].matches).toEqual([]);
    expect(rows[2].matches).toEqual([]);
    const many = matchReferences([{ name: '여비 규정', count: 1, context: '' }], Array.from({ length: 9 }, (_, i) => cand({ name: '여비 규정', id: `d${i}` })));
    expect(many[0].matches).toHaveLength(REFERENCE_MAX_MATCHES);
  });
  it('지난 판뿐이면 표시, 법령 꼴은 없을 때만, 요약', () => {
    const rows = matchReferences(extractCitations('「복무 지침」 「지방공기업법」 「없는 지침」 「여비 규정」'), [
      cand({ name: '복무 지침', status: 'retired' }),
      cand({ kind: 'common', id: 'c1', name: '여비 규정', editionYear: 2026 }),
    ]);
    expect(rows.map((r) => [r.retiredOnly, r.lawLike, r.matches.length])).toEqual([[true, false, 1], [false, true, 0], [false, false, 0], [false, false, 1]]);
    expect(summarizeReferences(rows)).toEqual({ cited: 4, matched: 1, retiredOnly: 1, lawLike: 1, unmatched: 1 });
    expect(rows.map((r) => referenceVerdict(r).tone)).toEqual(['warn', 'info', 'none', 'ok']);
  });
});

const actor: ActorScope = {
  userId: 'u1', isAdmin: true, departmentId: 'dep1', organizationId: 'org1', visibleDepartmentIds: ['dep1'], managedDepartmentIds: ['dep1'], managesWholeOrganization: false,
};
const docRow = (over: Partial<ReferenceDocumentRow> = {}): ReferenceDocumentRow => ({
  id: 'doc1', agent_id: 'ag1', department_id: 'dep1', organization_id: 'org1', visibility: 'organization', storage_path: 'p/doc1.hwpx', file_name: '출장 지침.hwpx',
  title: null, noda_status: 'ready', retired_at: null, effective_from: null, agent: { name: '총무 비서', deleted_at: null }, ...over,
});

describe('후보', () => {
  it('볼 수 있는 문서만(남의 부서 전용·지운 비서·지우는 중 제외), 공통 자료는 유형 것, 상태는 읽기 상태로', () => {
    const c = buildCandidates(actor, [
      docRow({ id: 'a', file_name: '여비 규정.hwpx' }),
      docRow({ id: 'b', visibility: 'department', department_id: 'dep9' }),
      docRow({ id: 'c', agent: { name: '옛 비서', deleted_at: '2026-01-01' } }),
      docRow({ id: 'd', noda_status: 'deleting' }),
      docRow({ id: 'e', noda_status: 'retired', retired_at: 't', title: '복무 지침', agent: [{ name: '인사 비서', deleted_at: null }] }),
    ], [{ id: 'c1', title: '예산편성기준', file_name: 'x.pdf', edition_year: 2026, noda_status: 'ready', retired_at: null }]);
    expect(c.map((x) => [x.kind, x.id, x.status, x.agentName ?? null])).toEqual([
      ['agent', 'a', 'current', '총무 비서'], ['agent', 'e', 'retired', '인사 비서'], ['common', 'c1', 'current', null],
    ]);
    expect(candidateStatus('reading')).toBe('reading');
    expect(candidateStatus(null)).toBe('unknown');
  });
});

describe('문서 하나의 참조 관계', () => {
  const deps = (over: Partial<ReferenceDeps> = {}): ReferenceDeps => ({
    loadDocument: vi.fn(async () => docRow()),
    readText: vi.fn(async () => ({ ok: true as const, text: '「여비 규정」에 따라 「예산편성기준」을 지킨다.', truncated: false })),
    listDocuments: vi.fn(async () => ({ rows: [docRow(), docRow({ id: 'a', file_name: '여비 규정.hwpx' })], truncated: false })),
    listCommon: vi.fn(async () => [{ id: 'c1', title: '예산편성기준', file_name: 'x.pdf', edition_year: 2026, noda_status: 'ready', retired_at: null }]),
    ...over,
  });
  it('원본을 읽어 인용을 찾고 기관 문서·공통 자료와 맞춘다', async () => {
    const d = deps();
    const r = await documentReferences('DOC1', actor, d);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(d.loadDocument).toHaveBeenCalledWith('doc1', 'org1');
    expect(d.readText).toHaveBeenCalledWith('p/doc1.hwpx', '출장 지침.hwpx');
    expect(r.data.document).toEqual({ id: 'doc1', name: '출장 지침.hwpx' });
    expect(r.data.rows.map((x) => x.matches.map((m) => m.id))).toEqual([['a'], ['c1']]);
    expect(r.data.summary).toMatchObject({ cited: 2, matched: 2 });
  });
  it('볼 수 없는 문서·없는 문서·지우는 중은 같은 404, 원본을 못 읽으면 그 이유', async () => {
    for (const row of [null, docRow({ visibility: 'department', department_id: 'dep9' }), docRow({ noda_status: 'deleting' }), docRow({ storage_path: null })]) {
      expect(await documentReferences('doc1', actor, deps({ loadDocument: async () => row }))).toEqual({ ok: false, status: 404, message: '문서를 찾을 수 없습니다.' });
    }
    expect(await documentReferences('doc1', actor, deps({ readText: async () => ({ ok: false, status: 422, message: '스캔본' }) }))).toEqual({ ok: false, status: 422, message: '스캔본' });
  });
});

describe('연결', () => {
  it('라우트는 관리자만, 문서 화면에 단추·창', () => {
    const route = readFileSync('src/app/api/documents/[id]/references/route.ts', 'utf8');
    expect(route).toContain('if (!isAdminSession(session))');
    expect(route).toContain('readText: readOriginalText');
    const manager = readFileSync('src/components/admin/DocumentsManager.tsx', 'utf8');
    expect(manager).toContain('onClick={() => setReferencesId(doc.id)}');
    expect(manager).toContain('<DocumentReferencesModal documentId={referencesId}');
    // 화면은 서버 모듈 값을 가져오지 않는다(꼴만)
    expect(readFileSync('src/components/admin/DocumentReferencesModal.tsx', 'utf8')).toContain("import type { CandidateStatus, ReferenceRow, ReferenceSummary } from '@/lib/document-references';");
  });
});
