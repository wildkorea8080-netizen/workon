import { NextRequest } from 'next/server';
import { getServerAuthSession } from '@/lib/auth';
import { defaultWorkContext, getWorkActor, handleWork, ok, readJson, UNAUTHORIZED, NO_ACTOR } from '@/lib/work/server';
import * as svc from '@/lib/work/services';

export const dynamic = 'force-dynamic';
export const maxDuration = 300;

/** 다른 작업의 결과 파일을 원자료로 가져오기 { artifactId, purpose? } — 이 작업 편집 권한 + 원래 작업 내려받기 권한 */
export async function POST(request: NextRequest, { params }: { params: { id: string } }) {
  return handleWork(async () => {
    const session = await getServerAuthSession();
    if (!session?.user?.id) return UNAUTHORIZED();
    const ctx = defaultWorkContext();
    const actor = await getWorkActor(session, ctx);
    if (!actor) return NO_ACTOR();
    const body = await readJson(request);
    return ok(await svc.importArtifactAsSource(ctx, actor, params.id, { artifactId: body.artifactId, purpose: body.purpose }), 201);
  });
}
