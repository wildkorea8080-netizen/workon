import { NextRequest } from 'next/server';
import { getServerAuthSession } from '@/lib/auth';
import { defaultWorkContext, getWorkActor, handleWork, ok, readJson, UNAUTHORIZED, NO_ACTOR } from '@/lib/work/server';
import * as svc from '@/lib/work/services';

export const dynamic = 'force-dynamic';

/** 복구 = 과거 내용으로 새 판(과거 판·파일은 그대로) */
export async function POST(request: NextRequest, { params }: { params: { id: string; versionId: string } }) {
  return handleWork(async () => {
    const session = await getServerAuthSession();
    if (!session?.user?.id) return UNAUTHORIZED();
    const ctx = defaultWorkContext();
    const actor = await getWorkActor(session, ctx);
    if (!actor) return NO_ACTOR();
    const body = await readJson(request);
    return ok(await svc.restoreVersion(ctx, actor, params.id, params.versionId, { baseVersion: body.baseVersion }));
  });
}
