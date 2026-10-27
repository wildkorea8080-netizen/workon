import { NextRequest } from 'next/server';
import { getServerAuthSession } from '@/lib/auth';
import { defaultWorkContext, getWorkActor, handleWork, ok, UNAUTHORIZED, NO_ACTOR } from '@/lib/work/server';
import * as svc from '@/lib/work/services';

export const dynamic = 'force-dynamic';

/** 업무 비서 10개와 이 기관에서 쓸 수 있는지 — 구현·양식이 없는 업무를 '사용 가능'으로 꾸미지 않는다 */
export async function GET(_request: NextRequest) {
  return handleWork(async () => {
    const session = await getServerAuthSession();
    if (!session?.user?.id) return UNAUTHORIZED();
    const ctx = defaultWorkContext();
    const actor = await getWorkActor(session, ctx);
    if (!actor) return NO_ACTOR();
    return ok(await svc.listWorkflowsForActor(ctx, actor));
  });
}
