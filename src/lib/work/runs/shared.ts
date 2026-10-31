// src/lib/work/runs/shared.ts
import { buildUsageDetails } from '@/lib/assistant/persist';
import { spentUsageOf } from '../generation/spent';
import type { LlmUsage } from '@/lib/llm';
import type { WorkContext } from '../context';
import type { WorkRunRow, WorkTaskRow } from '../types';
import { getWorkflowImpl, outputKeysOf } from '../workflows';
import { buildArtifact } from '../artifacts';
import { CHANGE_LOG_KEY } from '../workflows/currentize/output';

/**
 * 실행기(executor.ts)와 업무별 실행(currentize-op.ts)이 함께 쓰는 것 — 서로를 import하지 않게 따로 둔다.
 */

/** 단계 체크포인트 — 끝난 단계는 저장된 결과를 돌려주고 다시 하지 않는다(executor.ts processRun이 만든다) */
export type StepFn = <T extends Record<string, unknown>>(name: string, fn: () => Promise<T>) => Promise<T>;

/** 과금 규약 — 모델·토큰·기록 시점 원가. 작업·실행·시도·단계까지 남겨 대조할 수 있게 */
export async function writeModelUsage(ctx: WorkContext, run: WorkRunRow, task: WorkTaskRow, usage: LlmUsage | null, stage: string, extra: Record<string, unknown> = {}, action = 'work_generate') {
  if (!usage) return;
  await ctx.store.writeUsage({
    departmentId: task.department_id,
    userId: run.requested_by,
    action,
    resourceId: run.id,
    details: buildUsageDetails(usage, { task_id: task.id, run_id: run.id, attempt: run.attempt, workflow_key: task.workflow_key, agent_id: task.agent_id, stage, ...extra }),
  });
}

/**
 * 모델 호출 하나 — 성공이면 그 토큰을, 응답 검사에서 던졌으면 오류에 실린 쓴 토큰(`spentUsageOf`)을 **한 번** 남기고 원래 오류를 다시 던진다.
 * 모델 호출 자체가 실패한 오류(토큰 없음)는 남기지 않는다. 실패 기록을 쓰다 저장소가 던져도 원래 오류를 가리지 않는다.
 */
export async function callModel<T extends { usage: LlmUsage | null }>(ctx: WorkContext, run: WorkRunRow, task: WorkTaskRow, stage: string, call: () => Promise<T>, action = 'work_generate'): Promise<T> {
  let result: T;
  try {
    result = await call();
  } catch (error) {
    const spent = spentUsageOf(error);
    if (spent) {
      const code = error && typeof error === 'object' && typeof (error as { code?: unknown }).code === 'string' ? (error as { code: string }).code : 'unknown';
      try {
        await writeModelUsage(ctx, run, task, spent, stage, { failed: true, error_code: code }, action);
      } catch (writeError) {
        console.error('[work] 실패한 모델 호출의 사용 기록 실패', stage, writeError instanceof Error ? writeError.message : writeError);
      }
    }
    throw error;
  }
  await writeModelUsage(ctx, run, task, result.usage, stage, {}, action);
  return result;
}

/** 판의 결과 파일 만들기. 주 결과를 먼저 — 함께 만드는 파일(후속조치표 등)도 같은 판으로. 같은 판·같은 키는 한 벌이라 다시 시도해도 겹치지 않는다 */
export async function buildFileStep(ctx: WorkContext, run: WorkRunRow, task: WorkTaskRow, versionId: string) {
  const impl = getWorkflowImpl(task.workflow_key)!;
  // 현행화 판은 작년 파일을 고친 주 결과 + 변경 내역표(엑셀)
  const v = await ctx.store.getVersion(versionId, task.organization_id);
  const currentized = Boolean((v?.content as { currentize?: unknown } | null)?.currentize);
  const keys = currentized ? [impl.documentOutputKey, CHANGE_LOG_KEY] : outputKeysOf(impl);
  const built = [];
  for (const key of keys) built.push(await buildArtifact(ctx, task, versionId, key, run.id));
  return { artifactId: built[0].id, sha256: built[0].sha256, previewStatus: built[0].preview_status, artifactIds: built.map((a) => a.id) };
}
