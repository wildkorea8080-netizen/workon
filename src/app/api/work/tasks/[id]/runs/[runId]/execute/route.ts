import { NextRequest } from 'next/server';
import { getServerAuthSession } from '@/lib/auth';
import { defaultWorkContext, getWorkActor, handleWork, ok, UNAUTHORIZED, NO_ACTOR } from '@/lib/work/server';
import * as svc from '@/lib/work/services';
import { runWorker, newWorkerId } from '@/lib/work/runs/worker';

export const dynamic = 'force-dynamic';
export const maxDuration = 300;

/** 방금 만든 실행을 이 요청 안에서 처리한다(기다림을 줄이는 가속 — 내구성의 근거가 아니다). 요청이 끊겨도 실행은 DB에 남고 lease가 끝나면 작업자 엔드포인트·로컬 작업자가 이어 받는다 */
export async function POST(_request: NextRequest, { params }: { params: { id: string; runId: string } }) {
  return handleWork(async () => {
    const session = await getServerAuthSession();
    if (!session?.user?.id) return UNAUTHORIZED();
    const ctx = defaultWorkContext();
    const actor = await getWorkActor(session, ctx);
    if (!actor) return NO_ACTOR();
    await svc.loadTask(ctx, actor, params.id, 'edit');
    const run = await svc.getRunForActor(ctx, actor, params.id, params.runId);
    if (run.status === 'queued') await runWorker(ctx, { workerId: newWorkerId('web'), runId: params.runId, budgetMs: 280_000 });
    return ok(await svc.getRunForActor(ctx, actor, params.id, params.runId));
  });
}
