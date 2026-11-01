import { conditionHolds, type AppStep } from './definition';
import type { LlmCompletion, LlmMessage, LlmRequest, LlmUsage } from '@/lib/llm/types';

export type AppStepRecord = { name: string; status: 'pending' | 'running' | 'completed' | 'skipped' | 'failed' | 'not_run'; output?: string; reused?: boolean };
export function appStepsCompleted(value: unknown): boolean {
  if (value === undefined || value === null) return true;
  if (!Array.isArray(value)) return false;
  if (!value.length) return true;
  return value.every(step => step && ['completed', 'skipped'].includes(step.status)) && value[value.length - 1]?.status === 'completed';
}
export const APP_INTERMEDIATE_TOKENS = 1400;

/** All original inputs remain available; intermediate output is data, never a new system instruction. */
export function stageMessages(original: LlmMessage[], results: AppStepRecord[]): LlmMessage[] {
  const prior = results.filter(step => step.status === 'completed').map(step => ({ name: step.name, result: step.output }));
  return prior.length ? [...original, { role: 'assistant', content: '이전 단계 작업 결과를 확인했습니다.' }, { role: 'user', content: `아래는 이전 단계에서 작성한 작업 결과입니다. 원래 입력과 대조하고, 새로운 사실의 근거로 취급하지 마세요.\n${JSON.stringify(prior)}` }] : [...original];
}

export function stageSystem(system: string, step: AppStep, final: boolean): string {
  return `${system}\n\n현재 처리 단계: ${step.name}\n${step.instruction}\n이번 단계의 작업 결과만 작성하세요. 내부 추론이나 다음에 할 일에 대한 예고는 쓰지 마세요. 외부 조회·파일 생성·시스템 변경은 할 수 없습니다.${final ? ' 최종 응답 형식에 맞춰 완성된 초안을 작성하세요.' : ' 결과는 3,000자 이내로 간결하게 작성하세요.'}`;
}

export async function runAppIntermediateSteps(args: {
  steps: AppStep[]; records: AppStepRecord[]; model: string; system: string; messages: LlmMessage[];
  inputs?: Record<string, string>;
  usage: LlmUsage; complete: (request: LlmRequest) => Promise<LlmCompletion>;
  guard: () => Promise<void>; update: (index: number) => void;
}): Promise<{ system: string; messages: LlmMessage[] }> {
  if (args.steps.length < 1 || args.steps.length > 3) throw new Error('지원하지 않는 단계 수입니다.');
  if (args.steps[args.steps.length - 1].when) throw new Error('마지막 단계는 항상 실행해야 합니다.');
  for (let index = 0; index < args.steps.length - 1; index++) {
    if (args.records[index].status === 'completed' && args.records[index].reused) { args.update(index); continue; }
    const condition = args.steps[index].when;
    if (condition && !conditionHolds(condition, args.inputs)) {
      args.records[index].status = 'skipped'; args.update(index); continue;
    }
    args.records[index].status = 'running'; args.update(index);
    await args.guard();
    const response = await args.complete({ model: args.model, system: stageSystem(args.system, args.steps[index], false), messages: stageMessages(args.messages, args.records), maxTokens: APP_INTERMEDIATE_TOKENS });
    // Record billed usage even if the result is rejected or a later stage fails.
    args.usage.input_tokens += response.usage.input_tokens; args.usage.output_tokens += response.usage.output_tokens;
    if (!response.text.trim() || response.text.length > 12000 || response.usage.output_tokens >= APP_INTERMEDIATE_TOKENS) throw new Error('단계 결과가 비었거나 처리 길이 상한을 초과했습니다.');
    args.records[index].output = response.text.trim(); args.records[index].status = 'completed'; args.update(index);
  }
  const last = args.steps.length - 1;
  args.records[last].status = 'running'; args.update(last);
  await args.guard();
  return { system: stageSystem(args.system, args.steps[last], true), messages: stageMessages(args.messages, args.records) };
}
