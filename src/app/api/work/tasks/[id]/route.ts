import { NextRequest } from 'next/server';
import { getServerAuthSession } from '@/lib/auth';
import { defaultWorkContext, getWorkActor, handleWork, ok, readJson, UNAUTHORIZED, NO_ACTOR } from '@/lib/work/server';
import * as svc from '@/lib/work/services';

export const dynamic = 'force-dynamic';

/** 작업 상세 — 지금 판·확인 사항·파일·원자료·실행 */
export async function GET(_request: NextRequest, { params }: { params: { id: string } }) {
  return handleWork(async () => {
    const session = await getServerAuthSession();
    if (!session?.user?.id) return UNAUTHORIZED();
    const ctx = defaultWorkContext();
    const actor = await getWorkActor(session, ctx);
    if (!actor) return NO_ACTOR();
    return ok(await svc.getTaskDetail(ctx, actor, params.id));
  });
}

/** 제목·기한·입력 수정 — revision이 같을 때만(동시 수정은 409) */
export async function PATCH(request: NextRequest, { params }: { params: { id: string } }) {
  return handleWork(async () => {
    const session = await getServerAuthSession();
    if (!session?.user?.id) return UNAUTHORIZED();
    const ctx = defaultWorkContext();
    const actor = await getWorkActor(session, ctx);
    if (!actor) return NO_ACTOR();
    const body = await readJson(request);
    await svc.updateTaskMeta(ctx, actor, params.id, { revision: body.revision, title: body.title, dueDate: body.dueDate, form: body.form });
    return ok(await svc.getTaskDetail(ctx, actor, params.id));
  });
}
