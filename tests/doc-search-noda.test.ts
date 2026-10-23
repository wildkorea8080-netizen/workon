// tests/doc-search-noda.test.ts
import { describe, it, expect, vi } from 'vitest';
import {
  createDocSearch,
  docSearchAddendum,
  sourcesToChunks,
  isCleanMatch,
  searchAgentDocuments,
  ORPHAN_DELETE_WAIT_MS,
  DOCUMENTS_UNAVAILABLE_CODE,
  DOCUMENTS_UNAVAILABLE_MESSAGE,
  type AgentDocument,
  type DocSearchDeps,
} from '@/lib/capabilities/doc-search';
import { NodaError, type NodaContextResult, type NodaSource } from '@/lib/noda';
import type { TurnContext } from '@/lib/capabilities/types';

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

function deps(over: Partial<DocSearchDeps> = {}) {
  const log = vi.fn(async () => {});
  const fetchContext = vi.fn(async (): Promise<NodaContextResult> => ({
    context: `[1] ${id}__규정.hwp p.12\n국내 출장 일비 2만원`,
    sources: [src()],
    dropped: 2,
  }));
  const findDocuments = vi.fn(async (_ids: string[]): Promise<{ id: string; agent_id: string | null }[]> => []);
  const deleteOrphan = vi.fn(async (_agentId: string, _filename: string) => {});
  const d: DocSearchDeps = {
    documentsOf: async () => [ready()],
    fetchContext,
    findDocuments,
    deleteOrphan,
    log,
    ...over,
  };
  return {
    d,
    log: (d.log ?? log) as typeof log,
    fetchContext: d.fetchContext as typeof fetchContext,
    findDocuments: d.findDocuments as typeof findDocuments,
    deleteOrphan: d.deleteOrphan as typeof deleteOrphan,
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
    expect(out.systemAddendum).toContain('참고 자료:');
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
