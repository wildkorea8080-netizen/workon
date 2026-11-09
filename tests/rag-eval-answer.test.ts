import { readFileSync } from 'fs';
import { describe, expect, it, vi } from 'vitest';
import { prepareLikeChat, type AgentDocument, type DocSearchDeps } from '@/lib/capabilities/doc-search';
import type { NodaContextResult } from '@/lib/noda';
import type { LlmRequest } from '@/lib/llm/types';
import type { RetrievedChunk } from '@/lib/db';
import { parseRagEvalSet, ragEvalCsv, ragEvalSetText, scoreRagEvalRow, summarizeRagEval, answerNote, type RagEvalResult, type RagEvalRow } from '@/lib/rag-eval';
import {
  RAG_EVAL_ANSWER_MAX_QUESTIONS, RAG_EVAL_ANSWER_TEXT_MAX, citedNumbers, compareAnswers, missingKeywords, saysNotFound, scoreAnswer, summarizeAnswers,
} from '@/lib/rag-eval-answer';
import { ANSWER_FAILED_MESSAGE, ANSWER_SEARCH_FAILED_MESSAGE, ANSWER_TIMEOUT_MESSAGE, runRagEval, type RagEvalRunDeps } from '@/lib/rag-eval-run';

/** 문서 찾기 평가의 '답변까지 평가'(2026-11-08) — 인용·숫자·핵심어를 프로그램이 판정, 대화와 같은 프롬프트로 답을 한 번 */

const chunk = (n: number, title: string, scope?: 'common'): RetrievedChunk => ({ documentId: `d${n}`, documentTitle: title, chunkIndex: n - 1, n, text: '', similarity: 0.85, ...(scope ? { scope } : {}) });
const chunks = [chunk(1, '여비 규정'), chunk(2, '복무 규정'), chunk(3, '예산편성기준', 'common')];

describe('답 글 읽기', () => {
  it('인용 번호 — 중복 없이 나온 순서, 코드 안은 뺌', () => {
    expect(citedNumbers('일비는 2만원입니다[1]. 숙박은 [3][1] 따릅니다. `[9]` ```\n[8]\n```')).toEqual([1, 3]);
    expect(citedNumbers('[0] [1000] 없음')).toEqual([]);
  });
  it("'찾지 못했습니다'와 변형", () => {
    expect(saysNotFound('문서에서 찾지 못했습니다.')).toBe(true);
    expect(saysNotFound('관련 내용을 찾을 수 없습니다')).toBe(true);
    expect(saysNotFound('근거를 확인할 수 없습니다')).toBe(true);
    expect(saysNotFound('일비는 2만원입니다')).toBe(false);
  });
  it('핵심어 — 공백·대소문자·숫자 쉼표 무시', () => {
    expect(missingKeywords('일비는 20,000 원이고 KTX 일반실', ['20000원', 'ktx', '특실'])).toEqual(['특실']);
  });
});

describe('scoreAnswer', () => {
  const shown = [20000, 2];
  it('기대 문서를 인용하고 숫자·핵심어가 맞으면 맞음', () => {
    const a = scoreAnswer({ expected: '여비', keywords: ['2만원'] }, chunks, '일비는 하루 2만원입니다[1].', shown);
    expect(a).toMatchObject({ verdict: 'grounded', passed: true, cited: ['여비 규정'], unknownRefs: 0, unverifiedNumbers: [], keywordsMissing: [] });
  });
  it('인용은 맞아도 근거에 없는 숫자·빠진 핵심어·없는 번호면 맞지 않음', () => {
    expect(scoreAnswer({ expected: '여비' }, chunks, '일비는 하루 35,000원입니다[1].', shown)).toMatchObject({ verdict: 'grounded', passed: false, unverifiedNumbers: ['35,000'] });
    expect(scoreAnswer({ expected: '여비', keywords: ['숙박비'] }, chunks, '일비는 2만원[1]', shown)).toMatchObject({ passed: false, keywordsMissing: ['숙박비'] });
    expect(scoreAnswer({ expected: '여비' }, chunks, '일비는 2만원[1][7]', shown)).toMatchObject({ verdict: 'grounded', passed: false, unknownRefs: 1 });
  });
  it('다른 문서만 인용 · 찾지 못했다고 답함 · 인용 없이 답함', () => {
    expect(scoreAnswer({ expected: '여비' }, chunks, '연가는 신청합니다[2].', shown)).toMatchObject({ verdict: 'wrong_citation', passed: false, cited: ['복무 규정'] });
    expect(scoreAnswer({ expected: '여비' }, chunks, '문서에서 찾지 못했습니다.', shown)).toMatchObject({ verdict: 'declined', passed: false });
    expect(scoreAnswer({ expected: '여비' }, chunks, '보통 2만원 정도입니다.', shown)).toMatchObject({ verdict: 'no_citation', passed: false });
  });
  it('공통 자료 인용은 [공통] 이름 — 기대 문서가 공통 자료여도 맞음', () => {
    expect(scoreAnswer({ expected: '예산편성' }, chunks, '편성 원칙은 …[3]', shown)).toMatchObject({ verdict: 'grounded', cited: ['[공통] 예산편성기준'] });
  });
  it('엉뚱한 질문 — 문서를 인용하지 않으면 맞음, 인용하면 틀림', () => {
    expect(scoreAnswer({ expected: null }, [], '문서에서 찾지 못했습니다. 일반적으로는 …', shown)).toMatchObject({ verdict: 'correct_decline', passed: true });
    expect(scoreAnswer({ expected: null }, chunks, '점심은 …[2]', shown)).toMatchObject({ verdict: 'false_answer', passed: false });
  });
  it('답 글은 앞부분만 남긴다', () => {
    expect(scoreAnswer({ expected: null }, [], 'ㄱ'.repeat(5000), []).text.length).toBe(RAG_EVAL_ANSWER_TEXT_MAX);
  });
});

describe('세트의 기대 답 핵심어(넷째 칸)', () => {
  it('; 로 나눠 읽고, 기대 문서가 있어야 하며 5개·60자까지', () => {
    const ok = parseRagEvalSet('질문\t기대 문서\t기대 쪽\t기대 답 핵심어\n일비는?\t여비\t12\t2만원; 하루\n점심?\t\t\t');
    expect(ok.ok && ok.rows).toEqual([{ line: 2, question: '일비는?', expected: '여비', page: 12, keywords: ['2만원', '하루'] }, { line: 3, question: '점심?', expected: null, page: null }]);
    expect(parseRagEvalSet('점심?\t\t\t메뉴')).toMatchObject({ ok: false, errors: [expect.stringContaining('기대 문서도')] });
    expect(parseRagEvalSet('일비?\t여비\t\ta;b;c;d;e;f')).toMatchObject({ ok: false, errors: [expect.stringContaining('5개까지')] });
    expect(parseRagEvalSet(`일비?\t여비\t\t${'가'.repeat(61)}`)).toMatchObject({ ok: false });
  });
  it('세트 다시 쓰기 — 핵심어가 있으면 네 칸, 없으면 예전 세 칸 그대로', () => {
    const rows = (parseRagEvalSet('일비는?\t여비\t12\t2만원; 하루') as { rows: RagEvalRow[] }).rows;
    const text = ragEvalSetText(rows.map((r) => scoreRagEvalRow(r, [])));
    expect(text).toBe('질문\t기대 문서\t기대 쪽\t기대 답 핵심어\n일비는?\t여비\t12\t2만원; 하루');
    expect((parseRagEvalSet(text) as { rows: RagEvalRow[] }).rows[0].keywords).toEqual(['2만원', '하루']);
    expect(ragEvalSetText([{ question: 'q', expected: null, page: null }])).toBe('질문\t기대 문서\t기대 쪽\nq\t\t');
  });
});

const row = (line: number, question: string, expected: string | null, keywords?: string[]): RagEvalRow => ({ line, question, expected, page: null, ...(keywords ? { keywords } : {}) });

describe('요약·CSV·비교', () => {
  const r1: RagEvalResult = { ...scoreRagEvalRow(row(1, '일비?', '여비', ['2만원']), chunks), answer: { ...scoreAnswer({ expected: '여비', keywords: ['2만원'] }, chunks, '2만원[1]', [20000]), model: 'm', inputTokens: 1000, outputTokens: 100, costKrw: 6.1 } };
  const r2: RagEvalResult = { ...scoreRagEvalRow(row(2, '점심?', null), []), answer: { ...scoreAnswer({ expected: null }, [], '찾지 못했습니다', []), model: 'm', inputTokens: 500, outputTokens: 50, costKrw: 3.05 } };
  const r3: RagEvalResult = { ...scoreRagEvalRow(row(3, '연가?', '복무'), null), answer: { verdict: 'error', passed: false, text: '', cited: [], unknownRefs: 0, unverifiedNumbers: [], error: ANSWER_SEARCH_FAILED_MESSAGE } };
  it('답변 요약 — 맞음·인용·핵심어·엉뚱한 질문·못 만든 답·사용량', () => {
    expect(summarizeAnswers([r1, r2, r3])).toEqual({
      evaluated: 2, errors: 1, passed: 2, passRate: 1, expected: 1, grounded: 1, groundedRate: 1, numberIssues: 0,
      keywordRows: 1, keywordPasses: 1, keywordRate: 1, offTopic: 1, offTopicDeclined: 1, offTopicDeclineRate: 1,
      inputTokens: 1500, outputTokens: 150, costKrw: 9.15, models: ['m'],
    });
    expect(summarizeAnswers([scoreRagEvalRow(row(1, 'q', null), [])])).toBeUndefined();
    expect(summarizeRagEval([r1]).answers).toBeUndefined(); // 검색 요약은 그대로 — 라우트가 answers를 더한다
  });
  it('CSV — 답변까지 평가한 실행에만 답 칸, 답 글의 수식 주입 막기', () => {
    const csv = ragEvalCsv([r1, { ...r2, answer: { ...r2.answer!, text: '=HYPERLINK("x")' } }]);
    expect(csv.split('\n')[0]).toContain('기대 답 핵심어,답변 판정,답변 맞음,인용한 문서,답변');
    expect(csv).toContain(`"'=HYPERLINK(""x"")"`);
    expect(ragEvalCsv([scoreRagEvalRow(row(1, 'q', null), [])]).split('\n')[0]).not.toContain('답변');
    expect(answerNote(r3.answer!)).toBe(`답 만들기 실패 · ${ANSWER_SEARCH_FAILED_MESSAGE}`);
  });
  it('지난 실행과 답변 비교 — 맞음이 바뀐 질문만, 못 만든 답은 비교 안 함', () => {
    const bad: RagEvalResult = { ...r1, answer: { ...r1.answer!, passed: false } };
    expect(compareAnswers([bad, r2, r3], [r1, r2, { ...r3, answer: r1.answer }])).toEqual({ improved: [r1], regressed: [] });
    expect(compareAnswers([r1], [bad])).toEqual({ improved: [], regressed: [bad] });
  });
});

function deps(over: Partial<RagEvalRunDeps> = {}) {
  const complete = vi.fn(async (req: LlmRequest) => ({ text: `일비는 2만원입니다[1]. (${String(req.messages[0].content)})`, usage: { model: 'claude-sonnet-4-6', input_tokens: 1000, output_tokens: 200 } }));
  const logUsage = vi.fn(async () => {});
  const logFailure = vi.fn(async () => {});
  const d: RagEvalRunDeps = {
    prepare: vi.fn(async () => ({ chunks, systemAddendum: '참고 자료(이 기관 문서):\n[1] 여비 규정\n일비 20,000원' })),
    complete, logUsage, logFailure, now: () => 0, ...over,
  };
  return { d, complete, logUsage, logFailure };
}

describe('runRagEval', () => {
  const rows = [row(1, '일비는?', '여비', ['2만원']), row(2, '점심 추천', null)];
  it('찾기만 할 때는 모델을 부르지 않는다', async () => {
    const t = deps();
    const out = await runRagEval({ rows, concurrency: 2, budgetMs: 1000 }, t.d);
    expect(t.complete).not.toHaveBeenCalled();
    expect(out.results.map((r) => [r.verdict, 'answer' in r])).toEqual([['hit', false], ['false_evidence', false]]);
  });
  it('답변까지 — 비서 지시문 + 대화와 같은 참고 자료로 답하고, 사용 기록을 남기고, 판정·사용량을 싣는다', async () => {
    const t = deps();
    const out = await runRagEval({ rows: rows.slice(0, 1), answers: { systemPrompt: '너는 여비 담당이다', model: 'claude-sonnet-4-6' }, concurrency: 1, budgetMs: 1000 }, t.d);
    const req = t.complete.mock.calls[0][0];
    expect(req.model).toBe('claude-sonnet-4-6');
    expect(req.system).toBe('너는 여비 담당이다\n\n참고 자료(이 기관 문서):\n[1] 여비 규정\n일비 20,000원');
    expect(req.messages).toEqual([{ role: 'user', content: '일비는?' }]);
    expect(t.logUsage).toHaveBeenCalledWith({ model: 'claude-sonnet-4-6', input_tokens: 1000, output_tokens: 200 });
    // 2만원은 프롬프트의 20,000(…'만' 표기는 2로 읽힘 — 숫자 확인 규칙 그대로)과 대조
    expect(out.results[0].answer).toMatchObject({ verdict: 'grounded', cited: ['여비 규정'], model: 'claude-sonnet-4-6', inputTokens: 1000, outputTokens: 200, keywordsMissing: [] });
    expect(out.results[0].answer!.costKrw).toBeGreaterThan(0);
  });
  it('찾기 실패면 답을 만들지 않고, 모델 실패는 그 질문만 실패 + 운영 기록(질문 글 없이), 시간이 넘으면 만들지 않음', async () => {
    let t = deps({ prepare: async () => null });
    let out = await runRagEval({ rows: rows.slice(0, 1), answers: { systemPrompt: null, model: 'm' }, concurrency: 1, budgetMs: 1000 }, t.d);
    expect(t.complete).not.toHaveBeenCalled();
    expect(out).toMatchObject({ nodaFailures: 1, results: [{ verdict: 'error', answer: { verdict: 'error', error: ANSWER_SEARCH_FAILED_MESSAGE } }] });

    t = deps({ complete: async () => { throw new Error('overloaded'); } });
    out = await runRagEval({ rows: rows.slice(0, 1), answers: { systemPrompt: null, model: 'm' }, concurrency: 1, budgetMs: 1000 }, t.d);
    expect(out.results[0]).toMatchObject({ verdict: 'hit', answer: { verdict: 'error', error: ANSWER_FAILED_MESSAGE } });
    expect(t.logFailure).toHaveBeenCalledWith(expect.any(String), { line: 1, error: 'overloaded' });

    let clock = 0;
    t = deps({ now: () => clock, prepare: async () => { clock = 2000; return { chunks }; } });
    out = await runRagEval({ rows: rows.slice(0, 1), answers: { systemPrompt: null, model: 'm' }, concurrency: 1, budgetMs: 1000 }, t.d);
    expect(t.complete).not.toHaveBeenCalled();
    expect(out.results[0]).toMatchObject({ verdict: 'hit', answer: { error: ANSWER_TIMEOUT_MESSAGE } });
  });
  it('사용 기록이 실패해도 평가는 이어 간다', async () => {
    const t = deps({ logUsage: async () => { throw new Error('db'); } });
    const out = await runRagEval({ rows: rows.slice(0, 1), answers: { systemPrompt: null, model: 'm' }, concurrency: 1, budgetMs: 1000 }, t.d);
    expect(out.results[0].answer?.verdict).toBe('grounded');
  });
});

describe('prepareLikeChat — 대화 프롬프트에 붙을 글까지', () => {
  it('근거와 참고 자료·인용 규칙을 함께 돌려준다', async () => {
    const AGENT = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
    const DOC = '11111111-2222-4333-8444-555555555555';
    const doc: AgentDocument = { id: DOC, title: '여비 규정', file_name: '여비.hwp', noda_status: 'ready', replaces_id: null };
    const d: DocSearchDeps = {
      documentsOf: async () => [doc],
      fetchContext: async (): Promise<NodaContextResult> => ({ context: `[1] ${DOC}__여비.hwp\n일비 2만원`, sources: [{ n: 1, chunk_id: 'c1', doc_id: 'd', filename: `${DOC}__여비.hwp`, similarity: 0.86, anchors: [{ page: 3 }] }], dropped: 0 }),
      findDocuments: async () => [], deleteOrphan: async () => {}, orgTypeOf: async () => null, commonDocumentsOf: async () => [],
      fetchCommonContext: async () => ({ context: '', sources: [], dropped: 0 }), findCommonDocuments: async () => [], deleteCommonOrphan: async () => {}, log: async () => {},
    };
    const out = await prepareLikeChat({ agentId: AGENT, organizationId: 'org', query: '일비' }, d);
    expect(out?.chunks.map((c) => c.documentTitle)).toEqual(['여비 규정']);
    expect(out?.systemAddendum).toContain('일비 2만원');
    expect(out?.systemAddendum).not.toContain(`${DOC}__`);
  });
});

describe('라우트·화면 (원본)', () => {
  const route = readFileSync('src/app/api/admin/rag-eval/route.ts', 'utf8');
  it('답변 평가는 20개까지·한도를 먼저 보고·사용 기록 rag_eval_answer·비서 모델은 기관 정책으로', () => {
    expect(RAG_EVAL_ANSWER_MAX_QUESTIONS).toBe(20);
    expect(route).toContain('withAnswers && parsed.rows.length > RAG_EVAL_ANSWER_MAX_QUESTIONS');
    expect(route.indexOf('checkTokenLimit(actor.departmentId, actor.userId)')).toBeLessThan(route.indexOf('runRagEval('));
    expect(route).toContain("action: 'rag_eval_answer'");
    expect(route).toContain('resolveModel(settings.model_id as string | null, await getAllowedModelIds(orgId))');
    expect(route).toContain("body.answers === true");
  });
  it('활동 이름표 세 곳', () => {
    for (const f of ['src/app/api/admin/audit-logs/route.ts', 'src/lib/usage-summary.ts', 'src/components/admin/StatsDashboard.tsx']) {
      expect(readFileSync(f, 'utf8')).toContain("rag_eval_answer: '문서 찾기 평가 답변(AI)'");
    }
  });
  it('화면 — 답변까지 평가 고르기·20개 넘으면 막기·답 칸', () => {
    const panel = readFileSync('src/components/admin/RagEvalPanel.tsx', 'utf8');
    expect(panel).toContain('AI 답변까지 평가');
    expect(panel).toContain('...(withAnswers ? { answers: true, ...(withJudge ? { judge: true } : {}) } : {})');
    expect(panel).toContain('disabled={!agentId || running || !preview?.ok || tooManyForAnswers}');
  });
});
