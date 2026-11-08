import { readFileSync } from 'fs';
import { describe, expect, it, vi } from 'vitest';
import { searchLikeChat, type AgentDocument, type DocSearchDeps } from '@/lib/capabilities/doc-search';
import type { CommonSearchDoc } from '@/lib/capabilities/doc-search-common';
import { NodaError, type NodaContextResult, type NodaSource } from '@/lib/noda';
import {
  parseRagEvalSet, ragEvalSetText, scopeChangeNote, scoreRagEvalRow, summarizeRagEval, type RagEvalRow,
} from '@/lib/rag-eval';

/**
 * 일괄 평가가 대화와 똑같이 찾는다(2026-11-05) — 비서 보관함 + 기관 유형의 공통 자료실. 그리고 지난 평가의 세트를 다시 쓴다.
 */

const AGENT = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
const DOC = '11111111-2222-4333-8444-555555555555';
const COMMON = '99999999-8888-4777-8666-555555555555';

const agentDoc: AgentDocument = { id: DOC, title: '여비 규정', file_name: '여비.hwp', noda_status: 'ready', replaces_id: null };
const commonDoc: CommonSearchDoc = { id: COMMON, title: '예산편성기준', edition_year: 2026, org_type: '공공기관', noda_status: 'ready', retired_at: null, replaces_id: null } as CommonSearchDoc;
const src = (n: number, filename: string): NodaSource => ({ n, chunk_id: `c${n}`, doc_id: 'd', filename, similarity: 0.86, anchors: [{ page: n + 10 }] });

function deps(over: Partial<DocSearchDeps> = {}) {
  const fetchContext = vi.fn(async (): Promise<NodaContextResult> => ({ context: `[1] ${DOC}__여비.hwp\n일비 2만원`, sources: [src(1, `${DOC}__여비.hwp`)], dropped: 0 }));
  const fetchCommonContext = vi.fn(async (): Promise<NodaContextResult> => ({ context: `[1] ${COMMON}__예산편성기준(2026).pdf\n편성 원칙`, sources: [src(1, `${COMMON}__예산편성기준(2026).pdf`)], dropped: 0 }));
  const d: DocSearchDeps = {
    documentsOf: async () => [agentDoc],
    fetchContext,
    findDocuments: async () => [],
    deleteOrphan: async () => {},
    orgTypeOf: async () => '공공기관',
    commonDocumentsOf: async () => [commonDoc],
    fetchCommonContext,
    findCommonDocuments: async () => [],
    deleteCommonOrphan: async () => {},
    log: async () => {},
    ...over,
  };
  return { d, fetchContext, fetchCommonContext };
}

describe('searchLikeChat — 대화와 같은 찾기', () => {
  it('비서 보관함과 공통 자료실을 대화처럼 나눠 찾고(3000·2000), 공통 조각은 번호를 밀어 [공통]으로', async () => {
    const t = deps();
    const chunks = await searchLikeChat({ agentId: AGENT, organizationId: 'org', query: '일비' }, t.d);
    expect(t.fetchContext).toHaveBeenCalledWith(AGENT, '일비', 3000);
    expect(t.fetchCommonContext).toHaveBeenCalledWith('공공기관', '일비', 2000);
    expect(chunks?.map((c) => [c.documentTitle, c.scope ?? 'agent', c.n])).toEqual([['여비 규정', 'agent', 1], ['예산편성기준', 'common', 2]]);
  });
  it('기관 유형이 없으면 비서 보관함만(예산 4000), 문서가 하나도 없으면 빈 근거', async () => {
    const only = deps({ orgTypeOf: async () => null });
    expect((await searchLikeChat({ agentId: AGENT, organizationId: 'org', query: '일비' }, only.d))?.length).toBe(1);
    expect(only.fetchContext).toHaveBeenCalledWith(AGENT, '일비', 4000);
    expect(only.fetchCommonContext).not.toHaveBeenCalled();
    const none = deps({ documentsOf: async () => [], commonDocumentsOf: async () => [] });
    expect(await searchLikeChat({ agentId: AGENT, organizationId: 'org', query: '일비' }, none.d)).toEqual([]);
  });
  it('공통 자료실만 실패해도 대화처럼 찾기 실패(null)', async () => {
    const t = deps({ fetchCommonContext: async () => { throw new NodaError('HTTP 503', 'http', 503); } });
    expect(await searchLikeChat({ agentId: AGENT, organizationId: 'org', query: '일비' }, t.d)).toBeNull();
  });
  it('평가 라우트가 이 찾기를 쓴다(예전 searchAgentDocuments는 공통 자료실을 몰랐다)', () => {
    const route = readFileSync('src/app/api/admin/rag-eval/route.ts', 'utf8');
    expect(route).toContain('prepare: (query) => prepareLikeChat({ agentId: agent.id, organizationId: orgId, query })'); // 2026-11-08 — 같은 찾기 + 대화 프롬프트 글
    expect(route).not.toContain('searchAgentDocuments');
    expect(route).toContain("summarizeRagEval(results, 'chat')");
  });
  it('단건 검색 시험도 같은 찾기 — 못 부르면 대화처럼 503, 공통 근거는 [공통]으로 보인다(2026-11-05)', () => {
    const route = readFileSync('src/app/api/rag-test/route.ts', 'utf8');
    expect(route).toContain('await searchLikeChat({ agentId: agent.id, organizationId: actor.organizationId, query })');
    expect(route).not.toContain('searchAgentDocuments');
    expect(route).toMatch(/if \(chunks === null\)[\s\S]{0,200}DOCUMENTS_UNAVAILABLE_MESSAGE[\s\S]{0,40}status: 503/);
    // 옛 함수는 지웠다 — 공통 자료실을 모르는 찾기가 다시 생기지 않게
    expect(readFileSync('src/lib/capabilities/doc-search.ts', 'utf8')).not.toContain('export async function searchAgentDocuments');
    const ui = readFileSync('src/components/admin/RAGSearchTester.tsx', 'utf8');
    expect(ui).toContain('sourceTitleLabel(chunk)');
    // 결과 0개는 '아직 안 함'과 다르게 — 대화라면 근거 없음으로 답한다고 알린다
    expect(ui).toContain('근거를 찾지 못했습니다');
  });
});

const row = (over: Partial<RagEvalRow> = {}): RagEvalRow => ({ line: 1, question: '편성 원칙은?', expected: '예산편성기준', page: null, ...over });

describe('판정 — 공통 자료', () => {
  it('공통 문서도 기대 문서로 찾고, 상위 문서에 [공통]을 붙이며, 공통 근거 질문을 센다', () => {
    const hit = scoreRagEvalRow(row(), [{ documentTitle: '여비 규정', similarity: 0.8 }, { documentTitle: '예산편성기준', similarity: 0.9, scope: 'common' }]);
    expect(hit).toMatchObject({ verdict: 'hit', rank: 2, topDocuments: ['여비 규정', '[공통] 예산편성기준'], commonEvidence: true });
    const plain = scoreRagEvalRow(row({ expected: '여비' }), [{ documentTitle: '여비 규정', similarity: 0.8 }]);
    expect('commonEvidence' in plain).toBe(false);
    const failed = scoreRagEvalRow(row(), null);
    expect(summarizeRagEval([hit, plain, failed])).toMatchObject({ searchScope: 'chat', commonEvidenceQuestions: 1, errors: 1 });
  });
  it('찾은 범위가 바뀐 비교에는 안내를 붙인다(옛 기록은 범위 칸이 없고 비서 문서만 찾았다)', () => {
    expect(scopeChangeNote({}, { searchScope: 'chat' })).toContain('지난 평가는 비서 문서만');
    expect(scopeChangeNote({ searchScope: 'chat' }, { searchScope: 'chat' })).toBeNull();
    expect(scopeChangeNote({}, {})).toBeNull();
    expect(scopeChangeNote({ searchScope: 'chat' }, {})).toContain('지난 평가는 공통 자료실도');
  });
});

describe('세트 다시 쓰기 — 지난 평가 결과에서 세트를 다시 만든다', () => {
  it('다시 읽으면 같은 질문·기대 문서·기대 쪽(따옴표·쉼표가 든 질문도)', () => {
    const results = [
      { question: '출장 일비는 "하루" 얼마, 몇 원인가요?', expected: '여비 규정', page: 12 },
      { question: '점심 메뉴 추천해 줘', expected: null, page: null },
      { question: '편성 원칙은?', expected: '예산편성기준', page: null },
    ];
    const text = ragEvalSetText(results);
    expect(text.split('\n')[0]).toBe('질문\t기대 문서\t기대 쪽');
    const parsed = parseRagEvalSet(text);
    if (!parsed.ok) throw new Error(parsed.errors.join(' / '));
    expect(parsed.rows.map((r) => ({ question: r.question, expected: r.expected, page: r.page }))).toEqual(results);
  });
  it('화면 — 지난 평가마다 \'이 세트 다시 쓰기\', 비교에는 범위 안내', () => {
    const ui = readFileSync('src/components/admin/RagEvalPanel.tsx', 'utf8');
    expect(ui).toContain('setSet(ragEvalSetText(r.data.results))');
    expect(ui).toContain('이 세트 다시 쓰기');
    expect(ui).toContain('{compare.note && <p className="text-amber-700">{compare.note}</p>}');
  });
});
