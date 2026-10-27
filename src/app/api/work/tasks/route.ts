import { NextRequest } from 'next/server';
import { getServerAuthSession } from '@/lib/auth';
import { defaultWorkContext, getWorkActor, handleWork, ok, readJson, UNAUTHORIZED, NO_ACTOR } from '@/lib/work/server';
import * as svc from '@/lib/work/services';

export const dynamic = 'force-dynamic';

/** 내 작업함 — 내가 주인이거나 명시적으로 공유받은 작업만(커서 쪽 나눔) */
export async function GET(request: NextRequest) {
  return handleWork(async () => {
    const session = await getServerAuthSession();
    if (!session?.user?.id) return UNAUTHORIZED();
    const ctx = defaultWorkContext();
    const actor = await getWorkActor(session, ctx);
    if (!actor) return NO_ACTOR();
    const sp = request.nextUrl.searchParams;
    const status = sp.get('status')?.split(',').filter(Boolean);
    return ok(await svc.listTasks(ctx, actor, { status, workflowKey: sp.get('workflow') ?? undefined, cursor: sp.get('cursor'), limit: Number(sp.get('limit') ?? 20) }));
  });
}

/** 작업 만들기 — 기관·부서·주인은 서버가 세션에서 정한다 */
export async function POST(request: NextRequest) {
  return handleWork(async () => {
    const session = await getServerAuthSession();
    if (!session?.user?.id) return UNAUTHORIZED();
    const ctx = defaultWorkContext();
    const actor = await getWorkActor(session, ctx);
    if (!actor) return NO_ACTOR();
    const body = await readJson(request);
    const task = await svc.createTask(ctx, actor, { workflowKey: body.workflowKey, title: body.title, form: body.form, templateVersionId: body.templateVersionId, dueDate: body.dueDate });
    return ok(await svc.getTaskDetail(ctx, actor, task.id), 201);
  });
}
