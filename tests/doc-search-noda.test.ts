// tests/doc-search-noda.test.ts
import { describe, it, expect, vi } from 'vitest';
import {
  createDocSearch,
  docSearchAddendum,
  sourcesToChunks,
  isCleanMatch,
  searchAgentDocuments,
  ORPHAN_DELETE_WAIT_MS,
  contextPassages,
  PASSAGE_MAX_CHARS,
  CITE_NUMBER_RULE,
  DOCUMENTS_UNAVAILABLE_CODE,
  DOCUMENTS_UNAVAILABLE_MESSAGE,
  type AgentDocument,
  type DocSearchDeps,
} from '@/lib/capabilities/doc-search';
import { NodaError, NODA_CONTEXT_BUDGET, CONTEXT_BUDGET_AGENT_SHARED, CONTEXT_BUDGET_COMMON_SHARED, type NodaContextResult, type NodaSource } from '@/lib/noda';
import type { TurnContext } from '@/lib/capabilities/types';
import type { CommonSearchDoc } from '@/lib/capabilities/doc-search-common';
import { commonTenant, type OrgType } from '@/lib/org-types';

/**
 * 문서 찾기를 NODA /context로(S4-a). 실패가 조용한 곳이다 —
 * 근거에 남의 문서가 섞이거나, NODA가 죽었는데 근거 없이 답하거나,
 * 모델에 `{문서 id}__`가 새면 오류 없이 틀린 답이 나간다.
 */

const id = '11111111-2222-4333-8444-555555555555';
const id2 = '66666666-7777-4888-8999-aaaaaaaaaaaa';
const AGENT = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';

const ready = (over: Partial<AgentDocument> = {}): AgentDocument => ({
  id, title: '여비 규정', file_name: '규정.hwp', noda_status: 'ready', ...over,
});

const src = (over: Partial<NodaSource> = {}): NodaSource => ({
  n: 1, chunk_id: 'c1', doc_id: 'd', filename: `${id}__규정.hwp`, similarity: 0.85, ...over,
});

/** 공통 자료실(S5) — 유형 단위 문서 */
const CID = 'cccccccc-1111-4222-8333-444444444444';
const CID2 = 'dddddddd-1111-4222-8333-444444444444';

const commonDoc = (over: Partial<CommonSearchDoc> = {}): CommonSearchDoc => ({
  id: CID, title: '예산편성기준', edition_year: 2026, org_type: '공공기관', noda_status: 'ready', retired_at: null, replaces_id: null, ...over,
});

const csrc = (over: Partial<NodaSource> = {}): NodaSource => ({
  n: 1, chunk_id: 'k1', doc_id: 'nc', filename: `${CID}__예산편성기준(2026).pdf`, similarity: 0.88, ...over,
});

function deps(over: Partial<DocSearchDeps> = {}) {
  const log = vi.fn(async () => {});
  const fetchContext = vi.fn(async (): Promise<NodaContextResult> => ({
    context: `[1] ${id}__규정.hwp p.12\n국내 출장 일비 2만원`,
    sources: [src()],
    dropped: 2,
  }));
  const findDocuments = vi.fn(async (_ids: string[]): Promise<{ id: string; agent_id: string | null }[]> => []);
  const deleteOrphan = vi.fn(async (_agentId: string, _filename: string) => {});
  // 공통 자료실(S5) — 기본은 유형 없는 기관(공통 보관함을 찾지 않음)
  const orgTypeOf = vi.fn(async (_organizationId: string): Promise<string | null> => null);
  const commonDocumentsOf = vi.fn(async (_orgType: OrgType): Promise<CommonSearchDoc[]> => [commonDoc()]);
  const fetchCommonContext = vi.fn(async (_orgType: OrgType, _query: string, _budget: number): Promise<NodaContextResult> => ({
    context: `[1] ${CID}__예산편성기준(2026).pdf · 3쪽
여비 기준 단가`,
    sources: [csrc()],
    dropped: 1,
  }));
  const findCommonDocuments = vi.fn(async (_ids: string[]): Promise<{ id: string; org_type: string }[]> => []);
  const deleteCommonOrphan = vi.fn(async (_orgType: OrgType, _filename: string) => {});
  const d: DocSearchDeps = {
    documentsOf: async () => [ready()],
    fetchContext,
    findDocuments,
    deleteOrphan,
    orgTypeOf,
    commonDocumentsOf,
    fetchCommonContext,
    findCommonDocuments,
    deleteCommonOrphan,
    log,
    ...over,
  };
  return {
    d,
    log: (d.log ?? log) as typeof log,
    fetchContext: d.fetchContext as typeof fetchContext,
    findDocuments: d.findDocuments as typeof findDocuments,
    deleteOrphan: d.deleteOrphan as typeof deleteOrphan,
    orgTypeOf: d.orgTypeOf as typeof orgTypeOf,
    commonDocumentsOf: d.commonDocumentsOf as typeof commonDocumentsOf,
    fetchCommonContext: d.fetchCommonContext as typeof fetchCommonContext,
    findCommonDocuments: d.findCommonDocuments as typeof findCommonDocuments,
    deleteCommonOrphan: d.deleteCommonOrphan as typeof deleteCommonOrphan,
  };
}

const ctx = (over: Partial<TurnContext> = {}): TurnContext => ({
  organizationId: 'org', departmentId: 'dept', userId: 'u', agentId: AGENT, agentVersion: 1, conversationId: 'c', attachments: [],
  capabilities: { doc_search: {} }, message: '여비 규정', preflight: {}, skipDocuments: false, ...over,
});

/** preflight → prepare를 실행기 순서대로 */
async function turn(d: DocSearchDeps, skipDocuments = false) {
  const cap = createDocSearch(d);
  const pre = await cap.preflight!({ organizationId: 'org', agentId: AGENT, message: '여비 규정', skipDocuments });
  if (!pre.ok) throw new Error('거절됨');
  return cap.prepare!(ctx({ preflight: { doc_search: pre.carry }, skipDocuments }));
}

describe('sourcesToChunks', () => {
  it('근거를 쪽·칸·절·스캔 판독이 붙은 chunk로', () => {
    const chunks = sourcesToChunks(
      [
        { n: 1, chunk_id: 'c1', doc_id: 'd', filename: `${id}__규정.hwp`, outline: ['제3장', '여비'], anchors: [{ page: 12 }], extractors: ['ocr'], similarity: 0.86 },
        { n: 2, chunk_id: 'c2', doc_id: 'd2', filename: `${id}__표.csv`, anchors: [{ page: 0, cell_range: '표.csv!A3:D20' }], similarity: 0.83 },
      ],
      [{ id, title: '여비 규정', file_name: '규정.hwp', noda_status: 'ready' }]
    ).chunks;
    expect(chunks[0]).toMatchObject({ documentId: id, documentTitle: '여비 규정', chunkIndex: 0, page: 12, section: '제3장 › 여비', ocr: true, similarity: 0.86 });
    expect(chunks[1]).toMatchObject({ page: null, cellRange: '표.csv!A3:D20', ocr: false });
  });

  it('이 비서 행이 없는 조각·문서 id를 못 읽는 조각은 따로 모은다(근거 전체를 버릴 근거)', () => {
    const m = sourcesToChunks([src(), src({ n: 2, filename: `${id2}__남의.hwp` })], [ready()]);
    expect(isCleanMatch(m)).toBe(false);
    expect(m.unknown).toEqual([{ documentId: id2, filename: `${id2}__남의.hwp` }]);
    // 문서 id 앞부분이 없는 이름도 이 비서의 것인지 알 수 없다
    const m2 = sourcesToChunks([src(), src({ n: 2, filename: '규정.hwp' })], [ready()]);
    expect(isCleanMatch(m2)).toBe(false);
    expect(m2.unparsable).toEqual(['규정.hwp']);
  });

  it('deleting 행의 조각은 남긴다', () => {
    const m = sourcesToChunks([src()], [ready({ noda_status: 'deleting' })]);
    expect(isCleanMatch(m)).toBe(true);
    expect(m.chunks).toHaveLength(1);
  });

  it('이 비서의 행이지만 ready·deleting이 아니면 조용히 뺀다(실패한 행도 NODA 사본이 있을 수 있음)', () => {
    for (const status of ['reading', 'failed', 'unreadable', null] as const) {
      const m = sourcesToChunks([src(), src({ n: 2, filename: `${id2}__예전.hwp` })], [ready(), ready({ id: id2, noda_status: status })]);
      expect(isCleanMatch(m)).toBe(true);
      expect(m.chunks.map((c) => c.documentId)).toEqual([id]);
    }
  });

  it('형식이 깨진 조각은 센다 — 확인할 수 없으니 근거를 버릴 근거', () => {
    const m = sourcesToChunks([src(), null, 'x', { n: 3 }] as unknown as NodaSource[], [ready()]);
    expect(m.malformed).toBe(3);
    expect(isCleanMatch(m)).toBe(false);
  });

  it('제목이 없으면 원래 파일 이름, 칸 주소·절의 문서 id 앞부분은 뗀다', () => {
    const [c] = sourcesToChunks(
      [src({ outline: `${id}__규정.hwp › 제1장`, anchors: [{ page: 0, cell_range: `${id}__표.csv!A1` }] })],
      [ready({ title: null })]
    ).chunks;
    expect(c.documentTitle).toBe('규정.hwp');
    expect(c.cellRange).toBe('표.csv!A1');
    expect(c.section).toBe('규정.hwp › 제1장');
    expect(JSON.stringify(c)).not.toContain(`${id}__`);
  });
});

describe('근거 원문과 번호 — 오른쪽 근거 창(2026-10-23)', () => {
  const ctxText = [
    `[1] ${id}__규정.hwp · 43쪽 · 매뉴얼 > 서식 5`,
    `제7조 ② 전략위원회는 25명 이내의 위원으로 구성한다.`,
    `③ 위원장은 국무총리가 된다. (${id}__규정.hwp 참조)`,
    `[2] ${id}__규정.hwp · 2쪽`,
    `둘째 근거`,
  ].join('\n');

  it('근거 묶음을 [n]마다 원문으로 나눈다 — 머리 줄은 빼고 문서 id 앞부분도 뗀다', () => {
    const p = contextPassages(ctxText);
    expect(p.get(1)).toBe('제7조 ② 전략위원회는 25명 이내의 위원으로 구성한다.\n③ 위원장은 국무총리가 된다. (규정.hwp 참조)');
    expect(p.get(2)).toBe('둘째 근거');
    expect(p.size).toBe(2);
  });

  it('줄 가운데의 [3]은 근거 머리가 아니다', () => {
    const p = contextPassages(`[1] ${id}__a.pdf · 1쪽\n별표 [3] 참조`);
    expect(p.get(1)).toBe('별표 [3] 참조');
    expect(p.has(3)).toBe(false);
  });

  it(`원문은 ${PASSAGE_MAX_CHARS}자에서 자른다`, () => {
    const p = contextPassages(`[1] ${id}__a.pdf · 1쪽\n${'가'.repeat(PASSAGE_MAX_CHARS + 50)}`);
    expect(p.get(1)!.length).toBe(PASSAGE_MAX_CHARS + 1);
    expect(p.get(1)!.endsWith('…')).toBe(true);
  });

  it('조각에 NODA 번호(n)와 원문을 싣는다 — 빠진 조각이 있어도 번호가 밀리지 않는다', () => {
    const passages = contextPassages(ctxText);
    const { chunks } = sourcesToChunks(
      [src({ n: 1, filename: `${id2}__예전.hwp` }), src({ n: 2 })],
      [ready(), ready({ id: id2, noda_status: 'reading' })],
      passages
    );
    expect(chunks).toHaveLength(1);
    expect(chunks[0].n).toBe(2);
    expect(chunks[0].text).toBe('둘째 근거');
  });

  it('절은 outline이 비면 path(제목 사슬)로 — NODA는 제목 사슬을 path에 준다', () => {
    const [c] = sourcesToChunks([src({ outline: [], path: ['매뉴얼', '서식 5 서약서'] } as Partial<NodaSource>)], [ready()]).chunks;
    expect(c.section).toBe('매뉴얼 › 서식 5 서약서');
  });

  it('인용 규칙이 문장 끝에 자료 번호를 붙이라고 지시한다', () => {
    const text = docSearchAddendum({ context: '[1] a.pdf\n본문', chunks: [{ documentId: id, chunkIndex: 0, text: '', similarity: 0.9 }], hasDocuments: true, skipped: false })!;
    expect(text).toContain(CITE_NUMBER_RULE);
  });

  it('prepare가 만든 조각에 원문이 실린다', async () => {
    const { d } = deps();
    const out = await turn(d);
    expect(out.chunks![0].text).toBe('국내 출장 일비 2만원');
    expect(out.chunks![0].n).toBe(1);
  });
});

describe('doc_search preflight', () => {
  it('preflight: ready 문서가 없으면 NODA를 부르지 않는다', async () => {
    for (const docs of [[], [ready({ noda_status: 'reading' })], [ready({ noda_status: 'deleting' })], [ready({ noda_status: null })]]) {
      const { d, fetchContext } = deps({ documentsOf: async () => docs });
      const out = await createDocSearch(d).preflight!({ organizationId: 'org', agentId: AGENT, message: 'q', skipDocuments: false });
      expect(out.ok).toBe(true);
      expect(fetchContext).not.toHaveBeenCalled();
    }
  });

  it('ready 문서가 없는 비서는 NODA 장애 중에도 평소처럼 답한다(비서 프롬프트만)', async () => {
    const { d } = deps({
      documentsOf: async () => [],
      fetchContext: async () => { throw new NodaError('down', 'network'); },
    });
    const out = await turn(d);
    expect(out.systemAddendum).toBeUndefined();
    expect(out.chunks ?? []).toEqual([]);
  });

  it('preflight: NODA가 끝내 실패하면 503 documents_unavailable, 정한 문구', async () => {
    const { d, log } = deps({ fetchContext: async () => { throw new NodaError('HTTP 503', 'http', 503); } });
    const out = await createDocSearch(d).preflight!({ organizationId: 'org', agentId: AGENT, message: 'q', skipDocuments: false });
    expect(out).toEqual({ ok: false, status: 503, message: DOCUMENTS_UNAVAILABLE_MESSAGE, code: DOCUMENTS_UNAVAILABLE_CODE });
    expect(DOCUMENTS_UNAVAILABLE_MESSAGE).toBe('참고 문서를 지금 불러오지 못했습니다 — 잠시 뒤 다시 물어 주세요');
    expect(DOCUMENTS_UNAVAILABLE_CODE).toBe('documents_unavailable');
    expect(log).toHaveBeenCalledWith(
      expect.objectContaining({ level: 'warning', category: 'api', details: { agent_id: AGENT, code: 'http', status: 503 }, orgId: 'org' })
    );
    // 질문 원문은 운영 기록에 남기지 않는다
    expect(JSON.stringify(log.mock.calls)).not.toContain('"q"');
  });

  it('문서 목록을 읽지 못해도 근거 없이 답하지 않는다', async () => {
    const { d, fetchContext } = deps({ documentsOf: async () => { throw new Error('db down'); } });
    const out = await createDocSearch(d).preflight!({ organizationId: 'org', agentId: AGENT, message: 'q', skipDocuments: false });
    expect(out).toMatchObject({ ok: false, status: 503, code: DOCUMENTS_UNAVAILABLE_CODE });
    expect(fetchContext).not.toHaveBeenCalled();
  });

  it('preflight: skipDocuments면 NODA를 부르지 않는다', async () => {
    const documentsOf = vi.fn(async () => [ready()]);
    const { d, fetchContext } = deps({ documentsOf });
    const out = await createDocSearch(d).preflight!({ organizationId: 'org', agentId: AGENT, message: 'q', skipDocuments: true });
    expect(out.ok).toBe(true);
    expect(fetchContext).not.toHaveBeenCalled();
    expect(documentsOf).not.toHaveBeenCalled();
  });
});

describe('doc_search prepare', () => {
  it('prepare: 근거 글의 문서 id 앞부분이 모델에 가지 않는다', async () => {
    const { d } = deps();
    const out = await turn(d);
    expect(out.systemAddendum).toContain('참고 자료(이 기관 문서):');
    expect(out.systemAddendum).toContain('규정.hwp p.12');
    expect(out.systemAddendum).toContain('국내 출장 일비 2만원');
    expect(out.systemAddendum).not.toContain(`${id}__`);
    expect(out.chunks).toHaveLength(1);
    expect(out.dropped).toBe(2);
    expect(out.documentsSkipped).toBeFalsy();
  });

  it('prepare: sources가 비면 [문서 검색 결과 없음]', async () => {
    const { d } = deps({ fetchContext: async () => ({ context: '', sources: [], dropped: 5 }) });
    const out = await turn(d);
    expect(out.systemAddendum).toContain('[문서 검색 결과 없음]');
    expect(out.chunks).toEqual([]);
    expect(out.dropped).toBe(5);
  });

  const mixed = (filename: string) => async (): Promise<NodaContextResult> => ({
    context: `[1] ${id}__규정.hwp\n일비\n[2] ${filename}\n남의 글`,
    sources: [src(), src({ n: 2, filename })],
    dropped: 0,
  });

  it('prepare: 다른 비서의 행이 있는 조각(섞임)은 [문서 검색 결과 없음] + critical(security), 사본은 건드리지 않음', async () => {
    const { d, log, findDocuments, deleteOrphan } = deps({ fetchContext: mixed(`${id2}__남의.hwp`) });
    findDocuments.mockResolvedValue([{ id: id2, agent_id: 'other-agent' }]);
    const out = await turn(d);
    expect(findDocuments).toHaveBeenCalledTimes(1);
    expect(findDocuments).toHaveBeenCalledWith([id2]);
    expect(out.systemAddendum).toContain('[문서 검색 결과 없음]');
    expect(out.systemAddendum).not.toContain('남의 글');
    expect(out.chunks).toEqual([]);
    expect(log).toHaveBeenCalledWith(
      expect.objectContaining({
        level: 'critical',
        category: 'security',
        details: { agent_id: AGENT, source_count: 2, foreign_count: 1 },
        orgId: 'org',
      })
    );
    expect(deleteOrphan).not.toHaveBeenCalled();
  });

  it('prepare: 어디에도 행이 없는 조각(고아)은 근거 없이 + 사본 지우기 + warning(critical 아님)', async () => {
    const { d, log, deleteOrphan } = deps({ fetchContext: mixed(`${id2}__지운.hwp`) });
    const out = await turn(d);
    expect(out.chunks).toEqual([]);
    expect(out.systemAddendum).toContain('[문서 검색 결과 없음]');
    expect(out.systemAddendum).not.toContain('남의 글');
    expect(deleteOrphan).toHaveBeenCalledWith(AGENT, `${id2}__지운.hwp`);
    expect(log).toHaveBeenCalledWith(
      expect.objectContaining({ level: 'warning', details: expect.objectContaining({ orphan_count: 1, orphan_document_ids: [id2] }) })
    );
    expect(log.mock.calls.some((c) => (c as unknown as [{ level: string }])[0].level === 'critical')).toBe(false);
    // 운영 기록에 파일 이름을 남기지 않는다
    expect(JSON.stringify(log.mock.calls)).not.toContain('지운.hwp');
  });

  it('prepare: 문서 id를 못 읽는 조각도 고아 — 사본을 지우고 warning', async () => {
    const { d, log, deleteOrphan, findDocuments } = deps({ fetchContext: mixed('이름만.hwp') });
    const out = await turn(d);
    expect(out.chunks).toEqual([]);
    expect(findDocuments).not.toHaveBeenCalled();
    expect(deleteOrphan).toHaveBeenCalledWith(AGENT, '이름만.hwp');
    expect(log.mock.calls.map((c) => (c as unknown as [{ level: string }])[0].level)).toEqual(['warning']);
  });

  it('prepare: 고아 사본 지우기가 실패해도 던지지 않고 기록만', async () => {
    const { d, log } = deps({
      fetchContext: mixed(`${id2}__지운.hwp`),
      deleteOrphan: async () => { throw new NodaError('NODA 503', 'http', 503); },
    });
    const out = await turn(d);
    expect(out.chunks).toEqual([]);
    expect(log).toHaveBeenCalledWith(expect.objectContaining({ level: 'warning', message: expect.stringContaining('지우지 못함') }));
  });

  it('prepare: 고아 사본 지우기가 오래 걸려도 답을 오래 붙잡지 않는다', async () => {
    vi.useFakeTimers();
    try {
      const { d } = deps({
        fetchContext: mixed(`${id2}__지운.hwp`),
        deleteOrphan: () => new Promise<void>(() => {}), // 끝나지 않음
      });
      const p = turn(d);
      await vi.advanceTimersByTimeAsync(ORPHAN_DELETE_WAIT_MS + 10);
      const out = await p;
      expect(out.chunks).toEqual([]);
      expect(ORPHAN_DELETE_WAIT_MS).toBeLessThanOrEqual(2_000);
    } finally {
      vi.useRealTimers();
    }
  });

  it('prepare: 형식이 깨진 조각은 근거 없이 + warning', async () => {
    const { d, log, deleteOrphan } = deps({
      fetchContext: async () => ({
        context: `[1] ${id}__규정.hwp\n일비`,
        sources: [src(), { n: 2 } as unknown as NodaSource],
        dropped: 0,
      }),
    });
    const out = await turn(d);
    expect(out.chunks).toEqual([]);
    expect(out.systemAddendum).toContain('[문서 검색 결과 없음]');
    expect(deleteOrphan).not.toHaveBeenCalled();
    expect(log).toHaveBeenCalledWith(expect.objectContaining({ level: 'warning', details: expect.objectContaining({ malformed_count: 1 }) }));
  });

  it('prepare: 조각의 문서를 확인하지 못하면 근거 없이, 사본은 건드리지 않음', async () => {
    const { d, deleteOrphan } = deps({
      fetchContext: mixed(`${id2}__지운.hwp`),
      findDocuments: async () => { throw new Error('db down'); },
    });
    const out = await turn(d);
    expect(out.chunks).toEqual([]);
    expect(deleteOrphan).not.toHaveBeenCalled();
  });

  it('prepare: verifySources에 /context sources를 받은 순서대로 {doc_id, chunk_id}만 싣는다', async () => {
    const { d } = deps({
      fetchContext: async () => ({
        context: `[1] ${id}__규정.hwp\n일비\n[2] ${id}__규정.hwp\n숙박비`,
        sources: [src({ n: 1, doc_id: 'nd-2', chunk_id: 'k-7' }), src({ n: 2, doc_id: 'nd-1', chunk_id: 'k-3' })],
        dropped: 0,
      }),
    });
    const out = await turn(d);
    expect(out.chunks).toHaveLength(2);
    expect(out.verifySources).toEqual([
      { doc_id: 'nd-2', chunk_id: 'k-7' },
      { doc_id: 'nd-1', chunk_id: 'k-3' },
    ]);
  });

  it('prepare: doc_id·chunk_id가 깨진 원소가 하나라도 있으면 verifySources는 빈 배열 — [n]이 어긋나지 않게', async () => {
    const { d } = deps({
      fetchContext: async () => ({
        context: `[1] ${id}__규정.hwp\n일비\n[2] ${id}__규정.hwp\n숙박비`,
        sources: [src({ n: 1 }), src({ n: 2, chunk_id: undefined as unknown as string })],
        dropped: 0,
      }),
    });
    const out = await turn(d);
    expect(out.chunks).toHaveLength(2);
    expect(out.verifySources).toEqual([]);
  });

  it('prepare: 근거가 없는 턴(빈 sources·섞임·skip)은 verifySources가 비었다', async () => {
    const empty = await turn(deps({ fetchContext: async () => ({ context: '', sources: [], dropped: 5 }) }).d);
    expect(empty.verifySources ?? []).toEqual([]);
    const m = deps({ fetchContext: mixed(`${id2}__남의.hwp`) });
    m.findDocuments.mockResolvedValue([{ id: id2, agent_id: 'other-agent' }]);
    expect((await turn(m.d)).verifySources ?? []).toEqual([]);
    expect((await turn(deps().d, true)).verifySources ?? []).toEqual([]);
  });

  it('prepare: skip이면 일반 답변 안내와 documentsSkipped', async () => {
    const { d, fetchContext } = deps();
    const out = await turn(d, true);
    expect(out.documentsSkipped).toBe(true);
    expect(out.systemAddendum).toContain('[참고 문서 없이 답함]');
    expect(out.systemAddendum).toContain('참고 문서 없이');
    expect(out.systemAddendum).toContain('기관 자료에 근거하지 않는다');
    expect(out.chunks ?? []).toEqual([]);
    expect(fetchContext).not.toHaveBeenCalled();
  });
});

describe('docSearchAddendum', () => {
  const chunk = { documentId: id, documentTitle: '여비 규정', chunkIndex: 0, text: '', similarity: 0.85 };

  it('인용 규칙에 "문서에서 찾지 못했습니다" 줄이 있다', () => {
    const text = docSearchAddendum({ context: '[1] 규정.hwp\n일비', chunks: [chunk], hasDocuments: true, skipped: false })!;
    expect(text).toContain('[자료 인용 규칙]');
    expect(text).toContain('- 참고 자료에 질문의 답이 없으면 지어내지 말고 "문서에서 찾지 못했습니다"라고 답하세요.');
  });

  it('문서가 없으면 아무것도 붙이지 않는다', () => {
    expect(docSearchAddendum({ context: null, chunks: [], hasDocuments: false, skipped: false })).toBeUndefined();
  });
});

describe('doc_search — 공통 자료실(S5)', () => {
  const PUBLIC: OrgType = '공공기관';
  const LINE_EDITION = '공통 기준 자료는 정부가 정한 기준 문서입니다. 인용할 때는 문서 이름과 기준 연도를 함께 밝히세요(예: 예산편성기준(2026)).';
  const LINE_CONFLICT = '이 기관 문서와 공통 기준이 서로 다르게 말하면 한쪽을 고르지 말고 둘 다 보여 주고, 어느 것을 따를지는 기관 규정과 담당자가 판단한다고 안내하세요.';
  const AGENT_HEAD = '참고 자료(이 기관 문서):';
  const COMMON_HEAD = '참고 자료(공통 기준 — 공공기관 공통, 정부 기준 문서):';

  /** 유형이 공공기관인 기관 — 공통 보관함을 함께 찾는다 */
  const withCommon = (over: Partial<DocSearchDeps> = {}) => deps({ orgTypeOf: vi.fn(async () => PUBLIC), ...over });

  const preflight = (d: DocSearchDeps) =>
    createDocSearch(d).preflight!({ organizationId: 'org', agentId: AGENT, message: '여비 규정', skipDocuments: false });

  const twoAgentSources = async (): Promise<NodaContextResult> => ({
    context: `[1] ${id}__규정.hwp p.1\n일비\n[2] ${id}__규정.hwp p.2\n숙박비`,
    sources: [src({ n: 1, doc_id: 'na', chunk_id: 'a1' }), src({ n: 2, doc_id: 'na', chunk_id: 'a2' })],
    dropped: 0,
  });

  it('preflight — 비서·공통 ready 유무에 따라 /context 0·1·2번, 둘이면 3000·2000 예산으로 동시에', async () => {
    // 둘 다 없음: 유형 없는 기관 + 비서 문서 없음
    {
      const m = deps({ documentsOf: async () => [] });
      expect((await preflight(m.d)).ok).toBe(true);
      expect(m.fetchContext).not.toHaveBeenCalled();
      expect(m.fetchCommonContext).not.toHaveBeenCalled();
    }
    // 공통 행은 있지만 ready 현재 판이 없음(지난 판·읽는 중) + 비서 문서 없음
    {
      const m = withCommon({
        documentsOf: async () => [],
        commonDocumentsOf: vi.fn(async () => [
          commonDoc({ noda_status: 'retired', retired_at: '2026-10-01T00:00:00Z' }),
          commonDoc({ id: CID2, noda_status: 'reading' }),
        ]),
      });
      expect((await preflight(m.d)).ok).toBe(true);
      expect(m.fetchContext).not.toHaveBeenCalled();
      expect(m.fetchCommonContext).not.toHaveBeenCalled();
    }
    // 비서만
    {
      const m = deps();
      await preflight(m.d);
      expect(m.fetchContext).toHaveBeenCalledTimes(1);
      expect(m.fetchContext).toHaveBeenCalledWith(AGENT, '여비 규정', NODA_CONTEXT_BUDGET);
      expect(m.fetchCommonContext).not.toHaveBeenCalled();
    }
    // 공통만
    {
      const m = withCommon({ documentsOf: async () => [] });
      await preflight(m.d);
      expect(m.fetchContext).not.toHaveBeenCalled();
      expect(m.fetchCommonContext).toHaveBeenCalledTimes(1);
      expect(m.fetchCommonContext).toHaveBeenCalledWith(PUBLIC, '여비 규정', NODA_CONTEXT_BUDGET);
    }
    // 둘 다 — 비서 쪽이 끝나기 전에 공통 쪽도 이미 불렸다(동시에)
    {
      let release: () => void = () => {};
      const gate = new Promise<void>((r) => { release = r; });
      const m = withCommon({
        fetchContext: vi.fn(async () => {
          await gate;
          return twoAgentSources();
        }),
      });
      const p = preflight(m.d);
      await vi.waitFor(() => expect(m.fetchCommonContext).toHaveBeenCalledTimes(1));
      expect(m.fetchContext).toHaveBeenCalledTimes(1);
      release();
      expect((await p).ok).toBe(true);
      expect(m.fetchContext).toHaveBeenCalledWith(AGENT, '여비 규정', CONTEXT_BUDGET_AGENT_SHARED);
      expect(m.fetchCommonContext).toHaveBeenCalledWith(PUBLIC, '여비 규정', CONTEXT_BUDGET_COMMON_SHARED);
      expect([CONTEXT_BUDGET_AGENT_SHARED, CONTEXT_BUDGET_COMMON_SHARED]).toEqual([3000, 2000]);
    }
  });

  it('preflight — 공통만 실패해도 503 documents_unavailable', async () => {
    const m = withCommon({ fetchCommonContext: vi.fn(async () => { throw new NodaError('HTTP 502', 'http', 502); }) });
    const out = await preflight(m.d);
    expect(out).toEqual({ ok: false, status: 503, message: DOCUMENTS_UNAVAILABLE_MESSAGE, code: DOCUMENTS_UNAVAILABLE_CODE });
    expect(m.log).toHaveBeenCalledWith(
      expect.objectContaining({
        level: 'warning',
        category: 'api',
        details: expect.objectContaining({ agent_id: AGENT, org_type_key: 'public', code: 'http', status: 502 }),
        orgId: 'org',
      })
    );
    // 공통 문서만 있는 비서도 같다
    const only = withCommon({ documentsOf: async () => [], fetchCommonContext: vi.fn(async () => { throw new NodaError('down', 'network'); }) });
    expect(await preflight(only.d)).toMatchObject({ ok: false, status: 503, code: DOCUMENTS_UNAVAILABLE_CODE });
  });

  it('preflight — 유형 없는 기관·목록 밖 유형은 공통 행을 조회하지도 않는다', async () => {
    for (const type of [null, '기타', '']) {
      const m = deps({ orgTypeOf: vi.fn(async () => type) });
      const out = await preflight(m.d);
      expect(out.ok).toBe(true);
      expect(m.orgTypeOf).toHaveBeenCalledWith('org');
      expect(m.commonDocumentsOf).not.toHaveBeenCalled();
      expect(m.fetchCommonContext).not.toHaveBeenCalled();
      // 비서 문서는 지금처럼 4000 예산으로 찾는다
      expect(m.fetchContext).toHaveBeenCalledWith(AGENT, '여비 규정', NODA_CONTEXT_BUDGET);
    }
  });

  it('preflight — 유형 조회·공통 행 조회 실패는 503', async () => {
    const a = deps({ orgTypeOf: vi.fn(async () => { throw new Error('db down'); }) });
    expect(await preflight(a.d)).toMatchObject({ ok: false, status: 503, code: DOCUMENTS_UNAVAILABLE_CODE });
    expect(a.fetchContext).not.toHaveBeenCalled();
    expect(a.log).toHaveBeenCalledWith(expect.objectContaining({ level: 'error', category: 'database', orgId: 'org' }));

    const b = withCommon({ commonDocumentsOf: vi.fn(async () => { throw new Error('db down'); }) });
    expect(await preflight(b.d)).toMatchObject({ ok: false, status: 503, code: DOCUMENTS_UNAVAILABLE_CODE });
    expect(b.fetchContext).not.toHaveBeenCalled();
    expect(b.fetchCommonContext).not.toHaveBeenCalled();
    expect(b.log).toHaveBeenCalledWith(expect.objectContaining({ level: 'error', category: 'database' }));
  });

  it('prepare — 비서 근거 먼저, 공통 번호를 비서 최대 번호만큼 밀고 scope common·editionYear', async () => {
    const m = withCommon({ fetchContext: vi.fn(twoAgentSources) });
    const out = await turn(m.d);
    expect(out.chunks!.map((c) => [c.documentId, c.n, c.chunkIndex, c.scope])).toEqual([
      [id, 1, 0, undefined],
      [id, 2, 1, undefined],
      [CID, 3, 2, 'common'],
    ]);
    const common = out.chunks![2];
    expect(common).toMatchObject({ documentTitle: '예산편성기준', editionYear: 2026, text: '여비 기준 단가', page: null });
    // 모델이 보는 번호와 조각 번호가 같다 — 공통 머리 줄이 [3]으로 밀렸다
    expect(out.systemAddendum).toContain('[3] 예산편성기준(2026).pdf · 3쪽');
    expect(out.systemAddendum).not.toContain('[1] 예산편성기준');
    expect(out.systemAddendum).not.toContain(`${CID}__`);
    expect(out.systemAddendum).not.toContain(`${id}__`);
    expect(out.systemAddendum!.indexOf(AGENT_HEAD)).toBeLessThan(out.systemAddendum!.indexOf(COMMON_HEAD));
    expect(out.dropped).toBe(1 + 0);
  });

  it('prepare — 비서 조각이 없으면 공통 번호를 밀지 않고 verifyTenant는 공통 보관함', async () => {
    // 비서 근거는 모두 읽는 중인 문서의 것이라 조용히 빠진다(Review Focus 4)
    const m = withCommon({
      documentsOf: async () => [ready(), ready({ id: id2, noda_status: 'reading' })],
      fetchContext: vi.fn(async () => ({
        context: `[1] ${id2}__예전.hwp\n옛 글\n[2] ${id2}__예전.hwp\n옛 글2`,
        sources: [src({ n: 1, filename: `${id2}__예전.hwp` }), src({ n: 2, filename: `${id2}__예전.hwp` })],
        dropped: 0,
      })),
    });
    const out = await turn(m.d);
    expect(out.chunks!.map((c) => [c.documentId, c.n, c.chunkIndex])).toEqual([[CID, 1, 0]]);
    expect(out.verifySources).toEqual([{ doc_id: 'nc', chunk_id: 'k1' }]);
    expect(out.verifyTenant).toBe(commonTenant(PUBLIC));
    expect(out.verifyTenant).toBe('workon-c-public');
    expect(out.systemAddendum).toContain('[1] 예산편성기준(2026).pdf');
    expect(out.systemAddendum).toContain(COMMON_HEAD);
    expect(out.systemAddendum).not.toContain(AGENT_HEAD);

    // 공통 문서만 있는 비서도 같다
    const only = await turn(withCommon({ documentsOf: async () => [] }).d);
    expect(only.chunks!.map((c) => c.n)).toEqual([1]);
    expect(only.verifyTenant).toBe('workon-c-public');
  });

  it('prepare — 둘 다 조각이 있으면 verifySources 빈 배열', async () => {
    const out = await turn(withCommon({ fetchContext: vi.fn(twoAgentSources) }).d);
    expect(out.chunks).toHaveLength(3);
    expect(out.verifySources).toEqual([]);
    expect(out.verifyTenant).toBeUndefined();
    // 비서 조각만이면 지금처럼 비서 보관함(verifyTenant 없음)
    const agentOnly = await turn(deps({ fetchContext: vi.fn(twoAgentSources) }).d);
    expect(agentOnly.verifySources).toEqual([{ doc_id: 'na', chunk_id: 'a1' }, { doc_id: 'na', chunk_id: 'a2' }]);
    expect(agentOnly.verifyTenant).toBeUndefined();
  });

  it('prepare — 지난 판 조각의 글은 프롬프트에 싣지 않는다(설계 실패 기준 2), 번호는 그대로', async () => {
    const m = withCommon({
      documentsOf: async () => [],
      commonDocumentsOf: vi.fn(async () => [
        commonDoc(),
        commonDoc({ id: CID2, title: '예산편성기준', edition_year: 2025, noda_status: 'retired', retired_at: '2026-10-01T00:00:00Z' }),
      ]),
      fetchCommonContext: vi.fn(async () => ({
        context: `[1] ${CID}__예산편성기준(2026).pdf · 3쪽
새 단가 3만원
[2] ${CID2}__예산편성기준(2025).pdf · 3쪽
옛 단가 2만원`,
        sources: [csrc(), csrc({ n: 2, chunk_id: 'k2', filename: `${CID2}__예산편성기준(2025).pdf` })],
        dropped: 0,
      })),
    });
    const out = await turn(m.d);
    expect(out.chunks!.map((c) => [c.documentId, c.n])).toEqual([[CID, 1]]);
    expect(out.systemAddendum).toContain('[1] 예산편성기준(2026).pdf · 3쪽');
    expect(out.systemAddendum).toContain('새 단가 3만원');
    expect(out.systemAddendum).not.toContain('옛 단가 2만원');
    expect(out.systemAddendum).not.toContain('예산편성기준(2025)');
  });

  it('옛 판 내리기가 실패해 두 판이 모두 현재 판이어도 ready 새 판이 대신한 옛 판은 근거가 아니다', async () => {
    // 새 판(2026)은 ready·현재 판, 옛 판(2025)도 내리기에 실패해 아직 ready·현재 판
    const both = () => [
      commonDoc({ replaces_id: CID2 }),
      commonDoc({ id: CID2, edition_year: 2025 }),
    ];
    const m = withCommon({
      documentsOf: async () => [],
      commonDocumentsOf: vi.fn(async () => both()),
      fetchCommonContext: vi.fn(async () => ({
        context: `[1] ${CID2}__예산편성기준(2025).pdf
옛 단가 2만원
[2] ${CID}__예산편성기준(2026).pdf
새 단가 3만원`,
        sources: [csrc({ filename: `${CID2}__예산편성기준(2025).pdf` }), csrc({ n: 2, chunk_id: 'k2' })],
        dropped: 0,
      })),
    });
    const out = await turn(m.d);
    expect(out.chunks!.map((c) => [c.documentId, c.n])).toEqual([[CID, 2]]);
    expect(out.systemAddendum).not.toContain('옛 단가 2만원');
    expect(out.systemAddendum).toContain('새 단가 3만원');
    expect(m.log).not.toHaveBeenCalled();

    // 새 판이 아직 ready가 아니면(실패) 옛 판이 계속 근거 — preflight는 공통 보관함을 찾는다
    const onlyOld = withCommon({
      documentsOf: async () => [],
      commonDocumentsOf: vi.fn(async () => [commonDoc({ id: CID2, edition_year: 2025 }), commonDoc({ noda_status: 'failed', replaces_id: CID2 })]),
    });
    await preflight(onlyOld.d);
    expect(onlyOld.fetchCommonContext).toHaveBeenCalledTimes(1);
  });

  it('prepare — 다른 유형 공통 근거는 섞임: 전체 근거 버림·critical', async () => {
    const m = withCommon({
      fetchContext: vi.fn(twoAgentSources),
      fetchCommonContext: vi.fn(async () => ({
        context: `[1] ${CID}__예산편성기준(2026).pdf\n기준\n[2] ${CID2}__남의기준(2026).pdf\n남의 글`,
        sources: [csrc(), csrc({ n: 2, filename: `${CID2}__남의기준(2026).pdf` })],
        dropped: 0,
      })),
    });
    m.findCommonDocuments.mockResolvedValue([{ id: CID2, org_type: '중앙행정기관' }]);
    const out = await turn(m.d);
    expect(m.findCommonDocuments).toHaveBeenCalledWith([CID2]);
    expect(out.chunks).toEqual([]);
    expect(out.verifySources ?? []).toEqual([]);
    expect(out.systemAddendum).toContain('[문서 검색 결과 없음]');
    expect(out.systemAddendum).not.toContain('남의 글');
    expect(out.systemAddendum).not.toContain('숙박비');
    expect(m.log).toHaveBeenCalledWith(
      expect.objectContaining({
        level: 'critical',
        category: 'security',
        details: { agent_id: AGENT, org_type_key: 'public', foreign_count: 1 },
        orgId: 'org',
      })
    );
    expect(m.deleteCommonOrphan).not.toHaveBeenCalled();
    expect(JSON.stringify(m.log.mock.calls)).not.toContain('남의기준');
  });

  it('prepare — 비서 근거에 남의 비서 문서가 섞이면 깨끗한 공통 근거도 버린다', async () => {
    const mixedAgent = vi.fn(async () => ({
      context: `[1] ${id}__규정.hwp
일비
[2] ${id2}__남의.hwp
남의 글`,
      sources: [src(), src({ n: 2, filename: `${id2}__남의.hwp` })],
      dropped: 0,
    }));
    // 공통 근거는 깨끗하다(기본 — 이 유형의 ready 현재 판 하나)
    const m = withCommon({ fetchContext: mixedAgent });
    m.findDocuments.mockResolvedValue([{ id: id2, agent_id: 'other-agent' }]);
    const out = await turn(m.d);
    expect(out.chunks).toEqual([]);
    expect(out.verifySources).toEqual([]);
    expect(out.verifyTenant).toBeUndefined();
    expect(out.systemAddendum).toContain('[문서 검색 결과 없음]');
    expect(out.systemAddendum).not.toContain('예산편성기준');
    expect(out.systemAddendum).not.toContain('여비 기준 단가');
    expect(m.log).toHaveBeenCalledWith(
      expect.objectContaining({ level: 'critical', category: 'security', details: expect.objectContaining({ agent_id: AGENT, foreign_count: 1 }) })
    );
    expect(m.findCommonDocuments).not.toHaveBeenCalled();
    expect(m.deleteCommonOrphan).not.toHaveBeenCalled();

    // 공통 쪽에 고아가 있어도 맞추지 않으니 지우지도 않는다
    const o = withCommon({
      fetchContext: mixedAgent,
      fetchCommonContext: vi.fn(async () => ({ context: 'x', sources: [csrc({ filename: `${CID2}__지운기준(2025).pdf` })], dropped: 0 })),
    });
    o.findDocuments.mockResolvedValue([{ id: id2, agent_id: 'other-agent' }]);
    expect((await turn(o.d)).chunks).toEqual([]);
    expect(o.findCommonDocuments).not.toHaveBeenCalled();
    expect(o.deleteCommonOrphan).not.toHaveBeenCalled();
  });

  it('prepare — 유형을 바꾼 기관은 새 유형 보관함만 찾는다(옛 유형 행은 조회되지 않음)', async () => {
    // 공통 문서 표에는 두 유형의 행이 있다. 기관은 공공기관 → 지방자치단체로 바뀌었다(Review Focus 1)
    const LOCAL: OrgType = '지방자치단체';
    const table: CommonSearchDoc[] = [commonDoc(), commonDoc({ id: CID2, title: '지방재정 운영기준', org_type: LOCAL })];
    const m = deps({
      orgTypeOf: vi.fn(async () => LOCAL),
      commonDocumentsOf: vi.fn(async (t: OrgType) => table.filter((r) => r.org_type === t)),
      fetchCommonContext: vi.fn(async () => ({
        context: `[1] ${CID2}__지방재정 운영기준(2026).pdf\n지방 기준`,
        sources: [csrc({ filename: `${CID2}__지방재정 운영기준(2026).pdf` })],
        dropped: 0,
      })),
    });
    const out = await turn(m.d);
    expect(m.commonDocumentsOf.mock.calls).toEqual([[LOCAL]]);
    expect(m.fetchCommonContext.mock.calls.map((c) => c[0])).toEqual([LOCAL]);
    expect(m.findCommonDocuments).not.toHaveBeenCalled();
    expect(m.log.mock.calls.some((c) => (c as unknown as [{ level: string }])[0].level === 'critical')).toBe(false);
    expect(out.chunks!.map((c) => [c.documentId, c.scope])).toEqual([
      [id, undefined],
      [CID2, 'common'],
    ]);
    expect(out.systemAddendum).toContain('참고 자료(공통 기준 — 지방자치단체 공통, 정부 기준 문서):');
  });

  it('prepare — 공통 고아는 공통만 버리고 사본 삭제, 비서 근거는 남음', async () => {
    const m = withCommon({
      fetchCommonContext: vi.fn(async () => ({
        context: `[1] ${CID}__예산편성기준(2026).pdf\n기준\n[2] ${CID2}__지운기준(2025).pdf\n지운 글`,
        sources: [csrc(), csrc({ n: 2, filename: `${CID2}__지운기준(2025).pdf` })],
        dropped: 0,
      })),
    });
    const out = await turn(m.d);
    expect(out.chunks!.map((c) => c.documentId)).toEqual([id]);
    expect(m.deleteCommonOrphan).toHaveBeenCalledWith(PUBLIC, `${CID2}__지운기준(2025).pdf`);
    expect(m.log).toHaveBeenCalledWith(
      expect.objectContaining({
        level: 'warning',
        details: expect.objectContaining({ agent_id: AGENT, org_type_key: 'public', orphan_count: 1, orphan_document_ids: [CID2] }),
      })
    );
    expect(m.log.mock.calls.some((c) => (c as unknown as [{ level: string }])[0].level === 'critical')).toBe(false);
    expect(JSON.stringify(m.log.mock.calls)).not.toContain('지운기준');
    // 공통 근거는 모델에 가지 않고, 공통 인용 줄도 없다. 검증은 비서 보관함
    expect(out.systemAddendum).toContain(AGENT_HEAD);
    expect(out.systemAddendum).not.toContain(COMMON_HEAD);
    expect(out.systemAddendum).not.toContain('지운 글');
    expect(out.systemAddendum).not.toContain(LINE_EDITION);
    expect(out.verifySources).toEqual([{ doc_id: 'd', chunk_id: 'c1' }]);
    expect(out.verifyTenant).toBeUndefined();
  });

  it('prepare — 공통 고아 사본 지우기가 오래 걸려도 답을 오래 붙잡지 않는다', async () => {
    vi.useFakeTimers();
    try {
      const m = withCommon({
        fetchCommonContext: vi.fn(async () => ({ context: 'x', sources: [csrc({ filename: `${CID2}__지운기준(2025).pdf` })], dropped: 0 })),
        deleteCommonOrphan: () => new Promise<void>(() => {}),
      });
      const p = turn(m.d);
      await vi.advanceTimersByTimeAsync(ORPHAN_DELETE_WAIT_MS + 10);
      expect((await p).chunks!.map((c) => c.documentId)).toEqual([id]);
    } finally {
      vi.useRealTimers();
    }
  });

  it('prepare — 공통 근거의 깨진 원소·확인 실패는 공통만 버린다', async () => {
    const broken = withCommon({
      fetchCommonContext: vi.fn(async () => ({ context: 'x', sources: [csrc(), { n: 2 } as unknown as NodaSource], dropped: 0 })),
    });
    const a = await turn(broken.d);
    expect(a.chunks!.map((c) => c.documentId)).toEqual([id]);
    expect(broken.log).toHaveBeenCalledWith(expect.objectContaining({ level: 'warning', details: expect.objectContaining({ malformed_count: 1 }) }));

    const failing = withCommon({
      fetchCommonContext: vi.fn(async () => ({ context: 'x', sources: [csrc({ filename: `${CID2}__무엇(2025).pdf` })], dropped: 0 })),
      findCommonDocuments: vi.fn(async () => { throw new Error('db down'); }),
    });
    const b = await turn(failing.d);
    expect(b.chunks!.map((c) => c.documentId)).toEqual([id]);
    expect(failing.deleteCommonOrphan).not.toHaveBeenCalled();
    expect(failing.log).toHaveBeenCalledWith(expect.objectContaining({ level: 'error', category: 'database' }));
  });

  it('addendum — 공통 조각이 있을 때만 두 줄·머리 둘, 근거 없음 문구가 공통까지 넓어짐', () => {
    const agentChunk = { documentId: id, documentTitle: '여비 규정', chunkIndex: 0, n: 1, text: '', similarity: 0.85 };
    const commonChunk = { ...agentChunk, documentId: CID, chunkIndex: 1, n: 2, scope: 'common' as const, editionYear: 2026 };
    const base = { hasDocuments: true, skipped: false, commonOrgType: PUBLIC, searchedCommon: true };

    const agentOnly = docSearchAddendum({ ...base, context: '[1] 규정.hwp\n일비', commonContext: '', chunks: [agentChunk] })!;
    expect(agentOnly).toContain(AGENT_HEAD);
    expect(agentOnly).not.toContain('공통 기준 —');
    expect(agentOnly).not.toContain(LINE_EDITION);
    expect(agentOnly).not.toContain(LINE_CONFLICT);

    const both = docSearchAddendum({ ...base, context: '[1] 규정.hwp\n일비', commonContext: '[2] 예산편성기준(2026).pdf\n기준', chunks: [agentChunk, commonChunk] })!;
    expect(both).toContain(`${AGENT_HEAD}\n[1] 규정.hwp\n일비`);
    expect(both).toContain(`${COMMON_HEAD}\n[2] 예산편성기준(2026).pdf\n기준`);
    expect(both).toContain('[자료 인용 규칙]');
    // 두 줄은 인용 규칙 끝에, 글자 그대로
    const lines = both.split('\n');
    expect(lines.slice(-2)).toEqual([`- ${LINE_EDITION}`, `- ${LINE_CONFLICT}`]);
    expect(lines[lines.length - 3]).toBe(CITE_NUMBER_RULE);

    const commonOnly = docSearchAddendum({ ...base, context: '', commonContext: '[1] 예산편성기준(2026).pdf\n기준', chunks: [{ ...commonChunk, n: 1, chunkIndex: 0 }] })!;
    expect(commonOnly).toContain(COMMON_HEAD);
    expect(commonOnly).not.toContain(AGENT_HEAD);
    expect(commonOnly).toContain(LINE_EDITION);

    const none = docSearchAddendum({ ...base, context: '', commonContext: '', chunks: [] })!;
    expect(none).toContain('[문서 검색 결과 없음]');
    expect(none).toContain('이 비서의 문서와 공통 기준 자료에서 이번 질문과 관련된 내용을 찾지 못했습니다.');
    expect(none).not.toContain('이 비서에 연결된 문서에서');

    // 공통 보관함을 찾지 않은 턴은 지금 문구 그대로
    const agentSearchOnly = docSearchAddendum({ context: '', chunks: [], hasDocuments: true, skipped: false })!;
    expect(agentSearchOnly).toContain('이 비서에 연결된 문서에서 이번 질문과 관련된 내용을 찾지 못했습니다.');
  });
});

describe('searchAgentDocuments (rag-test)', () => {
  it('조각과 뺀 수를 돌려준다', async () => {
    const { d } = deps();
    expect(await searchAgentDocuments({ agentId: AGENT, query: 'q', organizationId: 'org' }, d)).toMatchObject({ chunks: [{ documentId: id }], dropped: 2 });
  });

  it('ready 문서가 없으면 NODA를 부르지 않는다', async () => {
    const { d, fetchContext } = deps({ documentsOf: async () => [] });
    expect(await searchAgentDocuments({ agentId: AGENT, query: 'q', organizationId: 'org' }, d)).toEqual({ chunks: [], dropped: 0 });
    expect(fetchContext).not.toHaveBeenCalled();
  });

  it('섞인 근거는 빈 조각 — critical 기록에 기관 id가 실린다', async () => {
    const { d, log, findDocuments } = deps({ fetchContext: async () => ({ context: 'x', sources: [src({ filename: `${id2}__남.hwp` })], dropped: 0 }) });
    findDocuments.mockResolvedValue([{ id: id2, agent_id: 'other-agent' }]);
    expect((await searchAgentDocuments({ agentId: AGENT, query: 'q', organizationId: 'org-1' }, d)).chunks).toEqual([]);
    expect(log).toHaveBeenCalledWith(expect.objectContaining({ level: 'critical', category: 'security', orgId: 'org-1' }));
  });
});

describe('경계', () => {
  it('doc-search.ts는 더 이상 rag.ts를 쓰지 않는다', async () => {
    const { readFileSync } = await import('fs');
    expect(readFileSync('src/lib/capabilities/doc-search.ts', 'utf8')).not.toMatch(/@\/lib\/rag['"]/);
  });
});
