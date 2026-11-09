import { readFileSync } from 'fs';
import { describe, expect, it, vi } from 'vitest';
import type { ActorScope } from '@/lib/agent-permissions';
import {
  CITED_BY_MAX, INDEX_BATCH, INDEX_BUDGET_MS, REFERENCE_MAX_CITATIONS, REFERENCE_MAX_MATCHES, buildCandidates, buildCitedBy, buildIndex, candidateKeys, candidateStatus,
  documentReferences, extractCitations, indexPendingDocuments, isLawLike, matchReferences, referenceKey, skipReasonFor, skippedIndex, summarizeReferences,
  type IndexDeps, type PendingIndexRow, type ReferenceCandidate, type ReferenceDeps, type ReferenceDocumentRow, type ReferenceIndex,
} from '@/lib/document-references';
import { INDEX_MAX_ROUNDS, coverageNote, indexDone, referenceVerdict } from '@/components/admin/DocumentReferencesModal';

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
  const NOW = new Date('2026-11-09T01:00:00Z');
  const deps = (over: Partial<ReferenceDeps> = {}) => {
    const saved: { id: string; index: ReferenceIndex }[] = [];
    const d: ReferenceDeps = {
      loadDocument: vi.fn(async () => docRow()),
      readText: vi.fn(async () => ({ ok: true as const, text: '「여비 규정」에 따라 「예산편성기준」을 지킨다.', truncated: false })),
      listDocuments: vi.fn(async () => ({ rows: [docRow(), docRow({ id: 'a', file_name: '여비 규정.hwpx' })], truncated: false })),
      listCommon: vi.fn(async () => [{ id: 'c1', title: '예산편성기준', file_name: 'x.pdf', edition_year: 2026, noda_status: 'ready', retired_at: null }]),
      saveIndex: vi.fn(async (id: string, _org: string, index: ReferenceIndex) => { saved.push({ id, index }); return true; }),
      listCiting: vi.fn(async () => [docRow({ id: 'b', file_name: '국외 출장 요령.hwpx' }), docRow(), docRow({ id: 'x', visibility: 'department', department_id: 'dep9' })]),
      coverage: vi.fn(async () => ({ indexed: 3, total: 10 })),
      now: () => NOW,
      ...over,
    };
    return { d, saved };
  };
  it('원본을 읽어 인용을 찾고 기관 문서·공통 자료와 맞추고, 그 결과로 참조 색인을 남긴다', async () => {
    const { d, saved } = deps();
    const r = await documentReferences('DOC1', actor, d);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(d.loadDocument).toHaveBeenCalledWith('doc1', 'org1');
    expect(d.readText).toHaveBeenCalledWith('p/doc1.hwpx', '출장 지침.hwpx');
    expect(r.data.document).toEqual({ id: 'doc1', name: '출장 지침.hwpx' });
    expect(r.data.rows.map((x) => x.matches.map((m) => m.id))).toEqual([['a'], ['c1']]);
    expect(r.data.summary).toMatchObject({ cited: 2, matched: 2 });
    expect(saved).toEqual([{ id: 'doc1', index: { v: 1, status: 'ok', keys: ['여비규정', '예산편성기준'], computed_at: NOW.toISOString() } }]);
  });
  it('거꾸로 — 이 문서 이름의 열쇠로 색인을 찾고, 볼 수 없는 문서·자기 문서는 빼고, 색인 범위를 함께', async () => {
    const { d } = deps();
    const r = await documentReferences('doc1', actor, d);
    if (!r.ok) throw new Error('x');
    expect(d.listCiting).toHaveBeenCalledWith('org1', ['출장지침']);
    expect(r.data.citedBy.map((x) => x.id)).toEqual(['b']);
    expect(r.data.coverage).toEqual({ indexed: 3, total: 10 });
  });
  it('원문을 글로 못 읽는 문서(스캔·너무 큼)도 거꾸로는 보이고, 건너뛴 색인을 남긴다. 저장소가 안 되면 그 이유로 실패', async () => {
    const scan = deps({ readText: async () => ({ ok: false, status: 422, message: '스캔본' }) });
    const r = await documentReferences('doc1', actor, scan.d);
    if (!r.ok) throw new Error('x');
    expect(r.data.outgoingError).toBe('스캔본');
    expect(r.data.rows).toEqual([]);
    expect(r.data.citedBy.map((x) => x.id)).toEqual(['b']);
    expect(scan.d.listDocuments).not.toHaveBeenCalled();
    expect(scan.saved[0].index).toMatchObject({ status: 'skipped', reason: 'unreadable', keys: [] });
    const down = deps({ readText: async () => ({ ok: false, status: 503, message: '잠시 뒤' }) });
    expect(await documentReferences('doc1', actor, down.d)).toEqual({ ok: false, status: 503, message: '잠시 뒤' });
    expect(down.saved).toEqual([]);
  });
  it('볼 수 없는 문서·없는 문서·지우는 중은 같은 404', async () => {
    for (const row of [null, docRow({ visibility: 'department', department_id: 'dep9' }), docRow({ noda_status: 'deleting' }), docRow({ storage_path: null })]) {
      expect(await documentReferences('doc1', actor, deps({ loadDocument: async () => row }).d)).toEqual({ ok: false, status: 404, message: '문서를 찾을 수 없습니다.' });
    }
  });
  it('색인 저장·범위 세기가 실패해도 결과는 돌려준다', async () => {
    const { d } = deps({ saveIndex: async () => { throw new Error('db'); }, coverage: async () => { throw new Error('db'); } });
    const r = await documentReferences('doc1', actor, d);
    expect(r).toMatchObject({ ok: true, data: { coverage: null } });
  });
});

describe('참조 색인', () => {
  it('열쇠는 인용 이름의 열쇠(겹침 없이), 못 읽은 이유는 다시 읽어도 같은 것만 건너뜀', () => {
    expect(buildIndex(extractCitations('「여비 규정」 「여비규정」 「복무 지침」'), new Date(0)).keys).toEqual(['여비규정', '복무지침']);
    expect(skippedIndex('deleting', new Date(0))).toMatchObject({ status: 'skipped', reason: 'deleting', keys: [] });
    expect([413, 422, 503, 500].map(skipReasonFor)).toEqual(['too_large', 'unreadable', null, null]);
  });
  it('거꾸로 목록은 지운 비서·지우는 중·겹침을 빼고 지금 판 먼저, 상한까지', () => {
    const rows = [
      docRow({ id: 'r', title: '가 지침', noda_status: 'retired', retired_at: 't' }),
      docRow({ id: 'c', title: '나 지침' }), docRow({ id: 'c', title: '나 지침' }),
      docRow({ id: 'd', noda_status: 'deleting' }),
      docRow({ id: 'g', agent: { name: '옛', deleted_at: 'x' } }),
    ];
    expect(buildCitedBy(actor, rows, 'self').map((x) => [x.id, x.status])).toEqual([['c', 'current'], ['r', 'retired']]);
    const many = Array.from({ length: CITED_BY_MAX + 5 }, (_, i) => docRow({ id: `m${i}` }));
    expect(buildCitedBy(actor, many, 'self')).toHaveLength(CITED_BY_MAX);
  });
});

describe('색인 만들기', () => {
  const pending = (over: Partial<PendingIndexRow> = {}): PendingIndexRow => ({
    id: 'p1', department_id: 'dep1', organization_id: 'org1', visibility: 'organization', storage_path: 'p/p1.hwpx', file_name: 'p1.hwpx', noda_status: 'ready', ...over,
  });
  const ideps = (rows: PendingIndexRow[], over: Partial<IndexDeps> = {}) => {
    const saved: { id: string; index: ReferenceIndex }[] = [];
    let t = 0;
    const d: IndexDeps = {
      listPending: vi.fn(async () => rows),
      readText: vi.fn(async (path: string) => path.includes('scan') ? { ok: false as const, status: 422, message: 's' } : path.includes('down') ? { ok: false as const, status: 503, message: 'd' } : { ok: true as const, text: '「여비 규정」', truncated: false }),
      saveIndex: vi.fn(async (id: string, _o: string, index: ReferenceIndex) => { saved.push({ id, index }); return true; }),
      coverage: vi.fn(async () => ({ indexed: 7, total: 9 })),
      now: () => t++,
      ...over,
    };
    return { d, saved };
  };
  it('볼 수 있는 문서만 다섯 개까지 — 읽으면 색인, 스캔은 건너뜀, 저장소가 안 되면 미룸, 지우는 중·원본 없음은 건너뜀', async () => {
    const rows = [
      pending({ id: 'hidden', visibility: 'department', department_id: 'dep9' }),
      pending({ id: 'ok' }), pending({ id: 'scan', storage_path: 'p/scan.pdf' }), pending({ id: 'down', storage_path: 'p/down.hwpx' }),
      pending({ id: 'del', noda_status: 'deleting' }), pending({ id: 'nofile', storage_path: null }), pending({ id: 'sixth' }),
    ];
    const { d, saved } = ideps(rows);
    const r = await indexPendingDocuments(actor, d);
    expect(d.listPending).toHaveBeenCalledWith('org1', INDEX_BATCH * 4);
    expect(saved.map((x) => [x.id, x.index.status])).toEqual([['ok', 'ok'], ['scan', 'skipped'], ['del', 'skipped'], ['nofile', 'skipped']]);
    expect(r).toEqual({ indexed: 1, skipped: 3, deferred: 1, coverage: { indexed: 7, total: 9 } });
    expect(saved.some((x) => x.id === 'hidden' || x.id === 'sixth')).toBe(false);
  });
  it('시간 예산을 넘기면 멈춘다', async () => {
    let t = 0;
    const { d, saved } = ideps([pending({ id: 'a' }), pending({ id: 'b' })], { now: () => (t += INDEX_BUDGET_MS + 1) });
    await indexPendingDocuments(actor, d);
    expect(saved).toEqual([]);
  });
});

describe('화면 판단', () => {
  it('색인 범위 안내와 멈출 때', () => {
    expect(coverageNote(null)).toBeNull();
    expect(coverageNote({ indexed: 5, total: 5 })).toBe('문서 5개 모두 색인했습니다.');
    expect(coverageNote({ indexed: 2, total: 5 })).toContain('5개 중 2개만');
    expect(indexDone({ indexed: 0, skipped: 0, deferred: 2, coverage: { indexed: 2, total: 5 } })).toBe(true);
    expect(indexDone({ indexed: 1, skipped: 0, deferred: 0, coverage: { indexed: 3, total: 5 } })).toBe(false);
    expect(indexDone({ indexed: 1, skipped: 0, deferred: 0, coverage: { indexed: 5, total: 5 } })).toBe(true);
    expect(INDEX_MAX_ROUNDS).toBeGreaterThan(0);
  });
});

describe('연결', () => {
  it('라우트는 관리자만, 문서 화면에 단추·창', () => {
    const route = readFileSync('src/app/api/documents/[id]/references/route.ts', 'utf8');
    expect(route).toContain('if (!isAdminSession(session))');
    expect(route).toContain('referenceDeps(actor)');
    const index = readFileSync('src/app/api/documents/references/build/route.ts', 'utf8');
    expect(index).toContain('if (!isAdminSession(session))');
    expect(index).toContain('indexPendingDocuments(actor, indexDeps(actor))');
    const db = readFileSync('src/lib/document-references-db.ts', 'utf8');
    expect(db).toContain('readText: readOriginalText');
    expect(db).toContain(".contains('metadata', { references: { keys: [key] } })");
    expect(db).toContain(".is('metadata->references', null)");
    expect(db).toContain('.or(visibilityFilter(actor))');
    expect(db).toContain('metadata: { ...base, references: index }');
    const manager = readFileSync('src/components/admin/DocumentsManager.tsx', 'utf8');
    expect(manager).toContain('onClick={() => setReferencesId(doc.id)}');
    expect(manager).toContain('<DocumentReferencesModal documentId={referencesId}');
    // 화면은 서버 모듈 값을 가져오지 않는다(꼴만)
    expect(readFileSync('src/components/admin/DocumentReferencesModal.tsx', 'utf8')).toContain("import type { CandidateStatus, CitingDocument, ReferenceRow, ReferenceSummary } from '@/lib/document-references';");
  });
});
