// src/lib/rag-eval-run.ts
// 문서 찾기 평가 실행기(서버) — 질문마다 대화와 같은 찾기를 하고, '답변까지 평가'(2026-11-08)면 대화와 같은 시스템 프롬프트로
// 답을 한 번 만들어 프로그램이 판정한다(rag-eval-answer.ts). 라우트는 권한·한도·저장만 하고 이 함수를 부른다.

import type { LlmCompletion, LlmRequest, LlmUsage } from '@/lib/llm/types';
import { buildSystemPrompt } from '@/lib/assistant/prompt';
import { numbersIn } from '@/lib/assistant/number-check';
import { estimateCostKrw } from '@/lib/models';
import { NodaError } from '@/lib/noda';
import type { RetrievedChunk } from '@/lib/db';
import { scoreRagEvalRow, type RagEvalResult, type RagEvalRow } from '@/lib/rag-eval';
import { RAG_EVAL_ANSWER_MAX_TOKENS, answerError, scoreAnswer } from '@/lib/rag-eval-answer';

export interface RagEvalRunDeps {
  /** 대화와 같은 찾기 — null이면 찾기 실패(대화라면 503) */
  prepare(query: string): Promise<{ chunks: RetrievedChunk[]; systemAddendum?: string } | null>;
  complete(req: LlmRequest): Promise<LlmCompletion>;
  /** 모델 사용 기록(과금 규약 — 모델·토큰·원가). 실패해도 평가는 이어 간다 */
  logUsage(usage: LlmUsage): Promise<void>;
  /** 모델 호출 실패 등 운영 기록(질문 글 없이) */
  logFailure(message: string, details: Record<string, unknown>): Promise<void>;
  now(): number;
}

export interface RagEvalRunInput {
  rows: RagEvalRow[];
  /** 답변까지 평가하면 그 비서의 지시문·정책을 거친 모델 */
  answers?: { systemPrompt: string | null; model: string };
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
        const completion = await deps.complete({
          model: input.answers.model,
          system,
          messages: [{ role: 'user', content: row.question }],
          maxTokens: RAG_EVAL_ANSWER_MAX_TOKENS,
        });
        await deps.logUsage(completion.usage).catch(() => {});
        // 대화의 숫자 확인과 같다 — 그 턴에 AI가 본 숫자 = 시스템 프롬프트(참고 자료 포함) + 질문
        const answer = scoreAnswer(row, prepared.chunks, completion.text, numbersIn(system).concat(numbersIn(row.question)));
        results[index] = {
          ...result,
          answer: {
            ...answer,
            model: completion.usage.model,
            inputTokens: completion.usage.input_tokens,
            outputTokens: completion.usage.output_tokens,
            costKrw: estimateCostKrw(completion.usage, completion.usage.model),
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
