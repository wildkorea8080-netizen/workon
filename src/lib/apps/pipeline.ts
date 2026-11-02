import { chooseBranch, conditionHolds, type AppBranch, type AppStep } from './definition';
import type { LlmCompletion, LlmMessage, LlmRequest, LlmUsage } from '@/lib/llm/types';

/** `branch` = 이 실행에서 고른 갈래 이름(기본 지시로 돌았으면 없음). 재개 검사가 지금 입력으로 고를 갈래와 맞춰 본다 */
export type AppStepRecord = { name: string; status: 'pending' | 'running' | 'completed' | 'skipped' | 'failed' | 'not_run'; output?: string; reused?: boolean; branch?: string };
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

/** 갈래가 골라졌으면 그 갈래의 지시, 아니면 단계의 기본 지시 */
export function stageSystem(system: string, step: AppStep, final: boolean, branch: AppBranch | null = null): string {
  return `${system}\n\n현재 처리 단계: ${step.name}${branch ? ` — ${branch.name}` : ''}\n${branch ? branch.instruction : step.instruction}\n이번 단계의 작업 결과만 작성하세요. 내부 추론이나 다음에 할 일에 대한 예고는 쓰지 마세요. 외부 조회·파일 생성·시스템 변경은 할 수 없습니다.${final ? ' 최종 응답 형식에 맞춰 완성된 초안을 작성하세요.' : ' 결과는 3,000자 이내로 간결하게 작성하세요.'}`;
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
    // 갈래 — 위에서부터 처음 맞는 하나. 기록에 이름을 남겨 재개 때 같은 갈래인지 맞춰 본다
    const branch = chooseBranch(args.steps[index], args.inputs);
    if (branch) args.records[index].branch = branch.name; else delete args.records[index].branch;
    args.records[index].status = 'running'; args.update(index);
    await args.guard();
    const response = await args.complete({ model: args.model, system: stageSystem(args.system, args.steps[index], false, branch), messages: stageMessages(args.messages, args.records), maxTokens: APP_INTERMEDIATE_TOKENS });
    // Record billed usage even if the result is rejected or a later stage fails.
    args.usage.input_tokens += response.usage.input_tokens; args.usage.output_tokens += response.usage.output_tokens;
    if (!response.text.trim() || response.text.length > 12000 || response.usage.output_tokens >= APP_INTERMEDIATE_TOKENS) throw new Error('단계 결과가 비었거나 처리 길이 상한을 초과했습니다.');
    args.records[index].output = response.text.trim(); args.records[index].status = 'completed'; args.update(index);
  }
  const last = args.steps.length - 1;
  const lastBranch = chooseBranch(args.steps[last], args.inputs);
  if (lastBranch) args.records[last].branch = lastBranch.name; else delete args.records[last].branch;
  args.records[last].status = 'running'; args.update(last);
  await args.guard();
  return { system: stageSystem(args.system, args.steps[last], true, lastBranch), messages: stageMessages(args.messages, args.records) };
}
