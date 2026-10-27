import { NextRequest } from 'next/server';
import { getServerAuthSession } from '@/lib/auth';
import { defaultWorkContext, getWorkActor, handleWork, ok, readJson, UNAUTHORIZED, NO_ACTOR } from '@/lib/work/server';
import * as svc from '@/lib/work/services';
import { confirmSource, sourceDto } from '@/lib/work/sources';
import { WorkError } from '@/lib/work/types';

export const dynamic = 'force-dynamic';
export const maxDuration = 300;

/** 원자료 확인 — 실제 객체·크기·해시를 보고 읽는다. 읽지 못한 파일은 failed(이유)로 돌려준다 */
export async function POST(request: NextRequest, { params }: { params: { id: string } }) {
  return handleWork(async () => {
    const session = await getServerAuthSession();
    if (!session?.user?.id) return UNAUTHORIZED();
    const ctx = defaultWorkContext();
    const actor = await getWorkActor(session, ctx);
    if (!actor) return NO_ACTOR();
    const { task } = await svc.loadTask(ctx, actor, params.id, 'edit');
    const body = await readJson(request);
    if (typeof body.sourceId !== 'string') throw new WorkError('INVALID_INPUT', 'sourceId가 필요합니다.');
    return ok(sourceDto(await confirmSource(ctx, task, body.sourceId)));
  });
}
