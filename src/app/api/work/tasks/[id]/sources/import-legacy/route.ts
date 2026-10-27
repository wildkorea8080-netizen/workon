import { NextRequest } from 'next/server';
import { getServerAuthSession } from '@/lib/auth';
import { defaultWorkContext, getWorkActor, handleWork, ok, readJson, UNAUTHORIZED, NO_ACTOR } from '@/lib/work/server';
import * as svc from '@/lib/work/services';

export const dynamic = 'force-dynamic';
export const maxDuration = 300;

/** 대화에서 만든 파일·대화 첨부를 원자료로 { kind: 'generated'|'attachment', id, purpose? } — 본인 것만(아니면 404) */
export async function POST(request: NextRequest, { params }: { params: { id: string } }) {
  return handleWork(async () => {
    const session = await getServerAuthSession();
    if (!session?.user?.id) return UNAUTHORIZED();
    const ctx = defaultWorkContext();
    const actor = await getWorkActor(session, ctx);
    if (!actor) return NO_ACTOR();
    const body = await readJson(request);
    return ok(await svc.importLegacyFile(ctx, actor, params.id, { kind: body.kind, id: body.id, purpose: body.purpose }), 201);
  });
}
