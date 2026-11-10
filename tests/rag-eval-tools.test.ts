import { readFileSync } from 'fs';
import { describe, expect, it, vi } from 'vitest';
import type { LlmRequest, LlmUsage } from '@/lib/llm/types';
import type { RetrievedChunk } from '@/lib/db';
import { ragEvalCsv, scoreRagEvalRow, type RagEvalResult, type RagEvalRow } from '@/lib/rag-eval';
import { scoreAnswer, summarizeAnswers } from '@/lib/rag-eval-answer';
import { runRagEval, type RagEvalRunDeps } from '@/lib/rag-eval-run';
import { RAG_EVAL_NO_TOOLS, evalAnswerWithTools, evalToolSetup, type EvalToolSetup } from '@/lib/rag-eval-tools';
import type { LoopArgs, LoopResult } from '@/lib/assistant/stream';
import type { SendEvent } from '@/lib/assistant/types';
import { summaryLine } from '@/components/admin/RagEvalPanel';

/** 문서 찾기 평가의 '도구를 쓰는 답'(2026-11-09) — 대화와 같은 도구 루프, 그 비서의 공공 데이터 도구만 */

const chunk = (n: number, title: string, text: string): RetrievedChunk => ({ documentId: `d${n}`, documentTitle: title, chunkIndex: n - 1, n, text, similarity: 0.85 });
const chunks = [chunk(1, '여비 규정', '일비는 하루 20,000원으로 한다.')];
const row = (line: number, question: string, expected: string | null): RagEvalRow => ({ line, question, expected, page: null });
const actor = { organizationId: 'o1', departmentId: 'dep1', userId: 'u1' };

describe('도구 고르기', () => {
  it('공공 데이터만 — 파일을 만드는 도구·첨부 도구는 꺼내지 않는다', async () => {
    const out = await evalToolSetup({ id: 'a1', tier: 'official', version: 3, capabilities: { doc_search: {}, document: {}, table_merge: {}, file_read: {}, public_data: { connectors: ['law'] } } }, actor, { knownConnectorIds: ['law'] });
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    const names = out.setup.tools.map((t) => t.name);
    expect(names.length).toBeGreaterThan(0);
    expect(names.every((n) => n.startsWith('law_'))).toBe(true);
    expect(names).not.toContain('fill_template');
    expect(names).not.toContain('combine_tables');
    expect(out.setup.ctx).toMatchObject({ organizationId: 'o1', departmentId: 'dep1', userId: 'u1', agentId: 'a1', agentVersion: 3, capabilities: { public_data: { connectors: ['law'] } }, attachments: [] });
  });

  it('켜진 공공 데이터 도구가 없거나, 나만의·부서 비서가 기관 범위 밖의 도구만 켰으면 고를 수 없다', async () => {
    expect(await evalToolSetup({ id: 'a1', tier: 'official', version: 1, capabilities: { doc_search: {} } }, actor, { knownConnectorIds: ['law'] })).toEqual({ ok: false, message: RAG_EVAL_NO_TOOLS });
    const scope = vi.fn(async () => ({ publicDataConnectors: new Set<string>() }));
    expect(await evalToolSetup({ id: 'a1', tier: 'personal', version: 1, capabilities: { public_data: { connectors: ['law'] } } }, actor, { scope: scope as never, knownConnectorIds: ['law'] })).toMatchObject({ ok: false });
    expect(scope).toHaveBeenCalledWith('dep1');
  });
});

describe('답 하나를 도구 루프로', () => {
  const setup = { tools: [{ name: 'law_search', description: '', input_schema: { type: 'object' } }], owners: new Map(), ctx: { organizationId: 'o1', departmentId: 'dep1', userId: 'u1', agentId: 'a1', agentVersion: 1, capabilities: {}, message: '', conversationId: '', attachments: [], preflight: {}, skipDocuments: false } } as unknown as EvalToolSetup;

  it('대화와 같은 루프 인자 — 부른 도구 이름을 모으고 쓴 토큰만 돌려준다', async () => {
    let seen: LoopArgs | null = null;
    const loop = vi.fn(async (args: LoopArgs, send: SendEvent): Promise<LoopResult> => {
      seen = args;
      send({ event: 'tool_start', data: { name: 'law_search', input: {} } });
      send({ event: 'tool_start', data: { name: 'law_search', input: {} } });
      send({ event: 'delta', data: { text: 'x' } });
      return { text: '답', usage: { model: 'm', input_tokens: 100, output_tokens: 20 }, capabilityUsage: [{ model: 'm', input_tokens: 0, output_tokens: 0 }], links: [], files: [], shownValues: [123456], attachmentToolSucceeded: false };
    });
    const out = await evalAnswerWithTools(setup, vi.fn(), loop)({ model: 'm', system: 'S', question: '질문' });
    expect(out).toEqual({ text: '답', usage: [{ model: 'm', input_tokens: 100, output_tokens: 20 }], shownValues: [123456], toolsUsed: ['law_search', 'law_search'] });
    expect(seen).toMatchObject({ modelId: 'm', systemPrompt: 'S', messages: [{ role: 'user', content: '질문' }], maxRounds: 4, ctx: { message: '질문', agentId: 'a1' } });
  });

  it('도중에 실패하면 그때까지 쓴 토큰을 기록하고 다시 던진다', async () => {
    const logUsage = vi.fn(async (_u: LlmUsage) => {});
    const loop = vi.fn(async (args: LoopArgs): Promise<LoopResult> => {
      args.progress!.usage.input_tokens = 300; args.progress!.usage.output_tokens = 10;
      throw new Error('overloaded');
    });
    await expect(evalAnswerWithTools(setup, logUsage, loop)({ model: 'm', system: 'S', question: 'q' })).rejects.toThrow('overloaded');
    expect(logUsage).toHaveBeenCalledWith({ model: 'm', input_tokens: 300, output_tokens: 10 });
  });
});

describe('runRagEval — 도구를 쓰는 답', () => {
  function deps(over: Partial<RagEvalRunDeps> = {}) {
    const complete = vi.fn(async (_req: LlmRequest) => ({ text: '모델만', usage: { model: 'm', input_tokens: 1, output_tokens: 1 } }));
    const logUsage = vi.fn(async () => {});
    const answerWithTools = vi.fn(async () => ({
      // 987,654,321은 도구 결과에만 있는 숫자 — '본 숫자'라 확인되지 않음으로 걸리지 않아야 한다
      text: '일비는 20,000원입니다[1]. 관련 예산은 987,654,321원입니다.',
      usage: [{ model: 'm', input_tokens: 1000, output_tokens: 100 }, { model: 'm', input_tokens: 500, output_tokens: 50 }],
      shownValues: [987654321], toolsUsed: ['law_search', 'law_article', 'law_search'],
    }));
    const d: RagEvalRunDeps = { prepare: vi.fn(async () => ({ chunks, systemAddendum: '참고 자료(이 기관 문서):\n[1] 여비 규정\n일비 20,000원' })), complete, logUsage, logFailure: vi.fn(async () => {}), now: () => 0, answerWithTools, ...over };
    return { d, complete, logUsage, answerWithTools };
  }

  it('고르면 도구 루프로 답하고, 쓴 토큰을 라운드마다 기록하고, 도구 숫자는 확인됨·부른 도구를 남긴다', async () => {
    const t = deps();
    const out = await runRagEval({ rows: [row(1, '일비는?', '여비')], answers: { systemPrompt: null, model: 'm', tools: true }, concurrency: 1, budgetMs: 1000 }, t.d);
    expect(t.complete).not.toHaveBeenCalled();
    expect(t.answerWithTools).toHaveBeenCalledWith({ model: 'm', system: expect.stringContaining('일비 20,000원'), question: '일비는?' });
    expect(t.logUsage).toHaveBeenCalledTimes(2);
    const a = out.results[0].answer!;
    expect(a).toMatchObject({ verdict: 'grounded', unverifiedNumbers: [], inputTokens: 1500, outputTokens: 150, toolCalls: 3, toolsUsed: ['law_search', 'law_article'] });
    expect(a.costKrw).toBeGreaterThan(0);
    expect(summarizeAnswers(out.results)).toMatchObject({ toolAnswers: 1 });
  });

  it('고르지 않으면 예전처럼 모델 한 번 — 도구 칸이 없다', async () => {
    const t = deps();
    const out = await runRagEval({ rows: [row(1, '일비는?', '여비')], answers: { systemPrompt: null, model: 'm' }, concurrency: 1, budgetMs: 1000 }, t.d);
    expect(t.answerWithTools).not.toHaveBeenCalled();
    expect(t.complete).toHaveBeenCalledTimes(1);
    expect(out.results[0].answer).not.toHaveProperty('toolCalls');
    expect(summarizeAnswers(out.results)).not.toHaveProperty('toolAnswers');
  });

  it('도구 루프가 실패하면 그 질문만 답 실패', async () => {
    const t = deps({ answerWithTools: vi.fn(async () => { throw new Error('connector down'); }) });
    const out = await runRagEval({ rows: [row(1, '일비는?', '여비')], answers: { systemPrompt: null, model: 'm', tools: true }, concurrency: 1, budgetMs: 1000 }, t.d);
    expect(out.results[0].answer).toMatchObject({ verdict: 'error' });
  });
});

describe('화면·CSV·라우트', () => {
  const result = (toolCalls?: number, toolsUsed?: string[]): RagEvalResult => ({
    ...scoreRagEvalRow(row(1, '일비는?', '여비'), [{ documentTitle: '여비 규정', page: null, similarity: 0.9 }] as never),
    answer: { ...scoreAnswer({ expected: '여비', keywords: undefined }, chunks, '일비는 20,000원입니다[1].', [20000]), ...(toolCalls !== undefined ? { toolCalls, ...(toolsUsed ? { toolsUsed } : {}) } : {}) },
  });
  it('CSV는 도구를 쓴 실행만 한 칸, 요약 줄에 도구 쓴 답', () => {
    const csv = ragEvalCsv([result(2, ['law_search'])]);
    expect(csv.split('\n')[0]).toContain('부른 도구');
    expect(csv.split('\n')[1]).toContain('law_search (2번)');
    expect(ragEvalCsv([result(0)]).split('\n')[1].endsWith('없음')).toBe(true);
    expect(ragEvalCsv([result()]).split('\n')[0]).not.toContain('부른 도구');
    const answers = summarizeAnswers([result(2, ['law_search']), { ...result(0), line: 2 }]);
    expect(summaryLine({ hits: 1, expected: 1, hitRate: 1, withPage: 0, pageHits: 0, pageHitRate: null, mrr: 1, offTopic: 0, offTopicRejected: 0, offTopicRejectRate: null, errors: 0, searchScope: 'chat', answers } as never)).toContain('도구 쓴 답 1/2');
  });
  it('라우트 — 도구는 답변까지 평가할 때만, 켜진 도구가 없으면 400, 사용 기록은 rag_eval_answer', () => {
    const route = readFileSync('src/app/api/admin/rag-eval/route.ts', 'utf8');
    expect(route).toContain("if (body.tools === true && !withAnswers) return jsonError('도구를 쓰는 답은 답변까지 평가할 때만 고를 수 있습니다.', 400);");
    expect(route).toContain('if (!setup.ok) return jsonError(setup.message, 400);');
    expect(route).toContain('answerWithTools: answerWithToolsOf(toolSetup, logAnswerUsage)');
    expect(route).toContain("await import('@/lib/rag-eval-tools')");
    expect(route).toMatch(/action: 'rag_eval_answer'/);
    const panel = readFileSync('src/components/admin/RagEvalPanel.tsx', 'utf8');
    expect(panel).toContain('...(withTools ? { tools: true } : {})');
  });
});
