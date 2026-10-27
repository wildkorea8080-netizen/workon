import { NextRequest } from 'next/server';
import { getServerAuthSession } from '@/lib/auth';
import { defaultWorkContext, getWorkActor, handleWork, ok, readJson, UNAUTHORIZED, NO_ACTOR } from '@/lib/work/server';
import * as svc from '@/lib/work/services';

export const dynamic = 'force-dynamic';

/** 현행화 변경 하나에 올해 글 { baseVersion, changeId, after } 또는 확인함 { baseVersion, changeId, acknowledge: true } — 새 판 + 파일 만들기, 기준 판이 바뀌었으면 409 */
export async function PATCH(request: NextRequest, { params }: { params: { id: string } }) {
  return handleWork(async () => {
    const session = await getServerAuthSession();
    if (!session?.user?.id) return UNAUTHORIZED();
    const ctx = defaultWorkContext();
    const actor = await getWorkActor(session, ctx);
    if (!actor) return NO_ACTOR();
    const body = await readJson(request);
    return ok(await svc.applyChangeEdit(ctx, actor, params.id, { baseVersion: body.baseVersion, changeId: body.changeId, after: body.after, acknowledge: body.acknowledge }));
  });
}
