import { NextRequest } from 'next/server';
import { getServerAuthSession } from '@/lib/auth';
import { defaultWorkContext, getWorkActor, handleWork, ok, readJson, UNAUTHORIZED, NO_ACTOR } from '@/lib/work/server';
import * as svc from '@/lib/work/services';

export const dynamic = 'force-dynamic';

/** 후보 적용 — 최신 판·권한·잠금을 다시 본 뒤 새 판과 파일 */
export async function POST(request: NextRequest, { params }: { params: { id: string; proposalId: string } }) {
  return handleWork(async () => {
    const session = await getServerAuthSession();
    if (!session?.user?.id) return UNAUTHORIZED();
    const ctx = defaultWorkContext();
    const actor = await getWorkActor(session, ctx);
    if (!actor) return NO_ACTOR();
    const body = await readJson(request);
    return ok(await svc.applyProposal(ctx, actor, params.id, params.proposalId, { baseVersion: body.baseVersion }));
  });
}
