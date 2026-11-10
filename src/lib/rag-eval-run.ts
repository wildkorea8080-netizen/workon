// src/lib/rag-eval-run.ts
// 문서 찾기 평가 실행기(서버) — 질문마다 대화와 같은 찾기를 하고, '답변까지 평가'(2026-11-08)면 대화와 같은 시스템 프롬프트로
// 답을 한 번 만들어 프로그램이 판정한다(rag-eval-answer.ts). 'AI 채점도'(2026-11-09)면 기대 문서가 있는 질문의 답마다 AI를 한 번 더 불러
// 근거 글과 맞대 채점한다(rag-eval-judge.ts — 참고, 프로그램 판정은 그대로). 라우트는 권한·한도·저장만 하고 이 함수를 부른다.

import type { LlmCompletion, LlmRequest, LlmUsage } from '@/lib/llm/types';
import { buildSystemPrompt } from '@/lib/assistant/prompt';
import { numbersIn } from '@/lib/assistant/number-check';
import { estimateCostKrw } from '@/lib/models';
import { NodaError } from '@/lib/noda';
import type { RetrievedChunk } from '@/lib/db';
import { scoreRagEvalRow, type RagEvalResult, type RagEvalRow } from '@/lib/rag-eval';
import { RAG_EVAL_ANSWER_MAX_TOKENS, answerError, scoreAnswer } from '@/lib/rag-eval-answer';
import {
  JUDGE_FAILED_MESSAGE, JUDGE_RULES, JUDGE_TIMEOUT_MESSAGE, JUDGE_UNREADABLE_MESSAGE, RAG_EVAL_JUDGE_MAX_TOKENS, judgeError, judgeMessage, parseJudge, type RagEvalJudge,
} from '@/lib/rag-eval-judge';

export interface RagEvalRunDeps {
  /** 대화와 같은 찾기 — null이면 찾기 실패(대화라면 503) */
  prepare(query: string): Promise<{ chunks: RetrievedChunk[]; systemAddendum?: string } | null>;
  complete(req: LlmRequest): Promise<LlmCompletion>;
  /** 모델 사용 기록(과금 규약 — 모델·토큰·원가). 실패해도 평가는 이어 간다 */
  logUsage(usage: LlmUsage): Promise<void>;
  /** AI 채점의 모델 사용 기록(`rag_eval_judge`) — AI 채점을 고른 실행에만 쓴다 */
  logJudgeUsage?(usage: LlmUsage): Promise<void>;
  /**
   * 도구를 쓰는 답(2026-11-09, `answers.tools`) — 대화와 같은 도구 루프(그 비서의 공공 데이터 도구만)로 답을 만든다.
   * 돌려주는 사용량은 라운드마다 모델별로, `shownValues`는 도구가 보여 준 숫자(숫자 확인의 '본 숫자'), `toolsUsed`는 부른 도구 이름(부른 순서, 겹쳐도 그대로)
   */
  answerWithTools?(input: { model: string; system: string; question: string }): Promise<{ text: string; usage: LlmUsage[]; shownValues: number[]; toolsUsed: string[] }>;
  /** 모델 호출 실패 등 운영 기록(질문 글 없이) */
  logFailure(message: string, details: Record<string, unknown>): Promise<void>;
  now(): number;
}

export interface RagEvalRunInput {
  rows: RagEvalRow[];
  /** 답변까지 평가하면 그 비서의 지시문·정책을 거친 모델 */
  answers?: { systemPrompt: string | null; model: string; judge?: boolean; tools?: boolean };
  concurrency: number;
  budgetMs: number;
}

export const ANSWER_TIMEOUT_MESSAGE = '평가 시간이 모자라 답을 만들지 않았습니다 — 질문을 줄여 다시 평가해 주세요.';
export const ANSWER_FAILED_MESSAGE = '답을 만들지 못했습니다.';
export const ANSWER_SEARCH_FAILED_MESSAGE = '문서를 찾지 못해 답을 만들지 않았습니다.';

/** 질문마다 찾고(그리고 답하고) 판정한다. 결과는 세트 순서 그대로. `nodaFailures` = 찾기 실패 수 */
export async function runRagEval(input: RagEvalRunInput, deps: RagEvalRunDeps): Promise<{ results: RagEvalResult[]; nodaFailures: number }> {
  const started = deps.now();
  const results: RagEvalResult[] = new Array(input.rows.length);
  let next = 0;
  let nodaFailures = 0;
  const overBudget = () => deps.now() - started > input.budgetMs;

  const judgeAnswer = async (row: RagEvalRow, chunks: RetrievedChunk[], answerText: string): Promise<RagEvalJudge> => {
    if (overBudget()) return judgeError(JUDGE_TIMEOUT_MESSAGE);
    try {
      const completion = await deps.complete({
        model: input.answers!.model,
        system: JUDGE_RULES,
        messages: [{ role: 'user', content: judgeMessage({ question: row.question, keywords: row.keywords, chunks, answer: answerText }) }],
        maxTokens: RAG_EVAL_JUDGE_MAX_TOKENS,
      });
      // 답을 못 읽어도 쓴 토큰은 기록한다(과금 규약)
      await (deps.logJudgeUsage ?? deps.logUsage)(completion.usage).catch(() => {});
      const cost = {
        model: completion.usage.model,
        inputTokens: completion.usage.input_tokens,
        outputTokens: completion.usage.output_tokens,
        costKrw: estimateCostKrw(completion.usage, completion.usage.model),
      };
      const parsed = parseJudge(completion.text);
      return parsed ? { ...parsed, ...cost } : { ...judgeError(JUDGE_UNREADABLE_MESSAGE), ...cost };
    } catch (error) {
      await deps.logFailure('문서 찾기 평가 — AI 채점을 하지 못했습니다', { line: row.line, error: error instanceof Error ? error.message.slice(0, 300) : 'unknown' }).catch(() => {});
      return judgeError(JUDGE_FAILED_MESSAGE);
    }
  };

  const worker = async () => {
    while (next < input.rows.length) {
      const index = next++;
      const row = input.rows[index];
      if (overBudget()) {
        results[index] = { ...scoreRagEvalRow(row, null), ...(input.answers ? { answer: answerError(ANSWER_TIMEOUT_MESSAGE) } : {}) };
        continue;
      }
      let prepared: Awaited<ReturnType<RagEvalRunDeps['prepare']>> = null;
      try {
        prepared = await deps.prepare(row.question);
        if (prepared === null) nodaFailures += 1;
      } catch (error) {
        if (error instanceof NodaError) nodaFailures += 1;
        else console.error('[rag-eval] 찾기 오류', error);
        prepared = null;
      }
      const result = scoreRagEvalRow(row, prepared ? prepared.chunks : null);
      if (!input.answers) { results[index] = result; continue; }
      if (!prepared) { results[index] = { ...result, answer: answerError(ANSWER_SEARCH_FAILED_MESSAGE) }; continue; }
      if (overBudget()) { results[index] = { ...result, answer: answerError(ANSWER_TIMEOUT_MESSAGE) }; continue; }

      const system = buildSystemPrompt(input.answers.systemPrompt, [prepared.systemAddendum]);
      try {
        // 도구를 쓰는 답(2026-11-09)이면 대화와 같은 도구 루프로, 아니면 모델 한 번
        const made = input.answers.tools && deps.answerWithTools
          ? await deps.answerWithTools({ model: input.answers.model, system, question: row.question })
          : await deps.complete({ model: input.answers.model, system, messages: [{ role: 'user', content: row.question }], maxTokens: RAG_EVAL_ANSWER_MAX_TOKENS })
            .then((c) => ({ text: c.text, usage: [c.usage], shownValues: [] as number[], toolsUsed: [] as string[] }));
        for (const usage of made.usage) await deps.logUsage(usage).catch(() => {});
        // 대화의 숫자 확인과 같다 — 그 턴에 AI가 본 숫자 = 시스템 프롬프트(참고 자료 포함) + 질문 + 도구가 보여 준 숫자
        const answer = scoreAnswer(row, prepared.chunks, made.text, numbersIn(system).concat(numbersIn(row.question), made.shownValues));
        // AI 채점 — 기대 문서가 있는 질문만(엉뚱한 질문은 프로그램 판정으로 충분하다)
        const judge = input.answers.judge && row.expected ? await judgeAnswer(row, prepared.chunks, made.text) : undefined;
        const tokens = (f: (u: LlmUsage) => number) => made.usage.reduce((s, u) => s + f(u), 0);
        const models = [...new Set(made.usage.map((u) => u.model))];
        const toolsUsed = [...new Set(made.toolsUsed)].slice(0, 10);
        results[index] = {
          ...result,
          answer: {
            ...answer,
            model: models.join(', ') || input.answers.model,
            inputTokens: tokens((u) => u.input_tokens),
            outputTokens: tokens((u) => u.output_tokens),
            costKrw: made.usage.reduce((s, u) => s + estimateCostKrw(u, u.model), 0),
            ...(input.answers.tools ? { toolCalls: made.toolsUsed.length, ...(toolsUsed.length ? { toolsUsed } : {}) } : {}),
            ...(judge ? { judge } : {}),
          },
        };
      } catch (error) {
        await deps.logFailure('문서 찾기 평가 — 답을 만들지 못했습니다', { line: row.line, error: error instanceof Error ? error.message.slice(0, 300) : 'unknown' }).catch(() => {});
        results[index] = { ...result, answer: answerError(ANSWER_FAILED_MESSAGE) };
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(input.concurrency, input.rows.length) }, worker));
  return { results, nodaFailures };
}
