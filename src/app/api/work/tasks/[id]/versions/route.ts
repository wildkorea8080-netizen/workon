import { NextRequest } from 'next/server';
import { getServerAuthSession } from '@/lib/auth';
import { defaultWorkContext, getWorkActor, handleWork, ok, UNAUTHORIZED, NO_ACTOR } from '@/lib/work/server';
import * as svc from '@/lib/work/services';

export const dynamic = 'force-dynamic';

/** 판 기록 — 작성 주체·이유·판별 파일 */
export async function GET(_request: NextRequest, { params }: { params: { id: string } }) {
  return handleWork(async () => {
    const session = await getServerAuthSession();
    if (!session?.user?.id) return UNAUTHORIZED();
    const ctx = defaultWorkContext();
    const actor = await getWorkActor(session, ctx);
    if (!actor) return NO_ACTOR();
    return ok(await svc.listVersions(ctx, actor, params.id));
  });
}
