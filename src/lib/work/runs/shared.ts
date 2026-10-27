// src/lib/work/runs/shared.ts
import { buildUsageDetails } from '@/lib/assistant/persist';
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
export async function writeModelUsage(ctx: WorkContext, run: WorkRunRow, task: WorkTaskRow, usage: LlmUsage | null, stage: string) {
  if (!usage) return;
  await ctx.store.writeUsage({
    departmentId: task.department_id,
    userId: run.requested_by,
    action: 'work_generate',
    resourceId: run.id,
    details: buildUsageDetails(usage, { task_id: task.id, run_id: run.id, attempt: run.attempt, workflow_key: task.workflow_key, agent_id: task.agent_id, stage }),
  });
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
