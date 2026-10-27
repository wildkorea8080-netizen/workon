import { NextRequest } from 'next/server';
import { getServerAuthSession } from '@/lib/auth';
import { defaultWorkContext, getWorkActor, handleWork, ok, UNAUTHORIZED, NO_ACTOR } from '@/lib/work/server';
import * as svc from '@/lib/work/services';

export const dynamic = 'force-dynamic';

/** 취소 — 대기 중이면 바로 취소, 실행 중이면 요청만 접수(작업자가 단계 사이에 멈춘다). 둘을 구분해 돌려준다 */
export async function POST(_request: NextRequest, { params }: { params: { id: string; runId: string } }) {
  return handleWork(async () => {
    const session = await getServerAuthSession();
    if (!session?.user?.id) return UNAUTHORIZED();
    const ctx = defaultWorkContext();
    const actor = await getWorkActor(session, ctx);
    if (!actor) return NO_ACTOR();
    return ok(await svc.cancelRun(ctx, actor, params.id, params.runId));
  });
}
