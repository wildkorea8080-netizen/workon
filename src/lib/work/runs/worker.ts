// src/lib/work/runs/worker.ts
import { randomUUID } from 'crypto';
import type { WorkContext } from '../context';
import { LEASE_SECONDS, processRun, type RunOutcome } from './executor';

/**
 * 작업자 한 바퀴 — 대기 실행(또는 lease가 끝난 실행)을 가져가 끝까지 처리한다.
 *
 * 부르는 곳(개편 05 문서 6절, ADR 0003):
 *  - /api/work/worker (WORK_WORKER_SECRET Bearer) — Vercel 예약 작업·Supabase pg_cron이 주기적으로 부른다
 *  - /api/work/tasks/[id]/runs/[runId]/execute — 직원이 실행을 만든 직후 화면이 부른다(바로 처리해 기다림을 줄임).
 *    화면이 닫혀 이 요청이 끊겨도 실행은 DB에 남고 lease가 끝나면 다른 작업자가 이어 받는다
 *  - scripts/work-worker.mjs — DATABASE_URL로 붙어 계속 도는 로컬·자체 서버 작업자
 * 내구성은 DB(실행 행·lease·체크포인트)에서 나온다. 응답 뒤에 함수를 흘려 두지 않는다.
 */
export function newWorkerId(prefix: string): string {
  return `${prefix}-${randomUUID().slice(0, 8)}`;
}

export async function runWorker(
  ctx: WorkContext,
  opts: { workerId: string; limit?: number; budgetMs?: number; runId?: string | null }
): Promise<RunOutcome[]> {
  const limit = opts.limit ?? 3;
  const budget = opts.budgetMs ?? 50_000;
  const started = Date.now();
  const outcomes: RunOutcome[] = [];
  while (outcomes.length < limit && Date.now() - started < budget) {
    const [run] = await ctx.store.claimRuns(opts.workerId, LEASE_SECONDS, 1, opts.runId ?? null);
    if (!run) break;
    outcomes.push(await processRun(ctx, run, opts.workerId));
    if (opts.runId) break;
  }
  return outcomes;
}
