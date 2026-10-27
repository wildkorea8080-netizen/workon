import { NextRequest } from 'next/server';
import { getServerAuthSession } from '@/lib/auth';
import { defaultWorkContext, getWorkActor, handleWork, ok, readJson, UNAUTHORIZED, NO_ACTOR } from '@/lib/work/server';
import * as svc from '@/lib/work/services';
import { createSourceUpload } from '@/lib/work/sources';

export const dynamic = 'force-dynamic';

/** 원자료 올리기 주소 — 형식·크기·개수를 먼저 거르고 서명 업로드 토큰을 준다(바이트는 함수를 거치지 않는다) */
export async function POST(request: NextRequest, { params }: { params: { id: string } }) {
  return handleWork(async () => {
    const session = await getServerAuthSession();
    if (!session?.user?.id) return UNAUTHORIZED();
    const ctx = defaultWorkContext();
    const actor = await getWorkActor(session, ctx);
    if (!actor) return NO_ACTOR();
    const { task } = await svc.loadTask(ctx, actor, params.id, 'edit');
    const body = await readJson(request);
    return ok(await createSourceUpload(ctx, task, actor.userId, { fileName: body.fileName, size: body.size, purpose: body.purpose }), 201);
  });
}
