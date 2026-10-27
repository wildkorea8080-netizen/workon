import { NextRequest } from 'next/server';
import { getServerAuthSession } from '@/lib/auth';
import { defaultWorkContext, getWorkActor, handleWork, ok, readJson, UNAUTHORIZED, NO_ACTOR } from '@/lib/work/server';
import * as svc from '@/lib/work/services';

export const dynamic = 'force-dynamic';

/** 확인 사항 처리(resolve·acknowledge)·검토 완료(approve — 지금 판만, 막는 사항·파일 확인) */
export async function POST(request: NextRequest, { params }: { params: { id: string } }) {
  return handleWork(async () => {
    const session = await getServerAuthSession();
    if (!session?.user?.id) return UNAUTHORIZED();
    const ctx = defaultWorkContext();
    const actor = await getWorkActor(session, ctx);
    if (!actor) return NO_ACTOR();
    const body = await readJson(request);
    return ok(await svc.reviewTask(ctx, actor, params.id, { action: body.action, itemId: body.itemId, note: body.note, versionId: body.versionId }));
  });
}
