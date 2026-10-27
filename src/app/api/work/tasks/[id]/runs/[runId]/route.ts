import { NextRequest } from 'next/server';
import { getServerAuthSession } from '@/lib/auth';
import { defaultWorkContext, getWorkActor, handleWork, ok, UNAUTHORIZED, NO_ACTOR } from '@/lib/work/server';
import * as svc from '@/lib/work/services';

export const dynamic = 'force-dynamic';

/** 실행 상태 — 조회만 한다(여기서 모델을 부르거나 처리를 걸지 않는다) */
export async function GET(_request: NextRequest, { params }: { params: { id: string; runId: string } }) {
  return handleWork(async () => {
    const session = await getServerAuthSession();
    if (!session?.user?.id) return UNAUTHORIZED();
    const ctx = defaultWorkContext();
    const actor = await getWorkActor(session, ctx);
    if (!actor) return NO_ACTOR();
    return ok(await svc.getRunForActor(ctx, actor, params.id, params.runId));
  });
}
