import { NextRequest } from 'next/server';
import { getServerAuthSession } from '@/lib/auth';
import { defaultWorkContext, getWorkActor, handleWork, ok, readJson, UNAUTHORIZED, NO_ACTOR } from '@/lib/work/server';
import * as svc from '@/lib/work/services';

export const dynamic = 'force-dynamic';

/** AI 수정 후보 요청 { baseVersion, fieldIds, instruction } — 선택한 칸만, 잠긴 칸 제외 */
export async function POST(request: NextRequest, { params }: { params: { id: string } }) {
  return handleWork(async () => {
    const session = await getServerAuthSession();
    if (!session?.user?.id) return UNAUTHORIZED();
    const ctx = defaultWorkContext();
    const actor = await getWorkActor(session, ctx);
    if (!actor) return NO_ACTOR();
    const body = await readJson(request);
    const key = request.headers.get('idempotency-key') ?? body.idempotencyKey;
    const r = await svc.requestRevision(ctx, actor, params.id, { baseVersion: body.baseVersion, fieldIds: body.fieldIds, instruction: body.instruction, idempotencyKey: key });
    return ok({ ...r, executeUrl: `/api/work/tasks/${params.id}/runs/${r.run.id}/execute` }, 202);
  });
}
