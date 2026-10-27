import { NextRequest } from 'next/server';
import { getServerAuthSession } from '@/lib/auth';
import { defaultWorkContext, getWorkActor, handleWork, ok, readJson, UNAUTHORIZED, NO_ACTOR } from '@/lib/work/server';
import * as svc from '@/lib/work/services';
import { WorkError } from '@/lib/work/types';

export const dynamic = 'force-dynamic';

/** 실행 만들기 — 지금은 '파일 만들기'(generate). Idempotency-Key 머리글(또는 본문 idempotencyKey)이 필요하다. 202 — 실제 처리는 작업자가 한다(화면은 executeUrl로 바로 처리를 걸 수 있다) */
export async function POST(request: NextRequest, { params }: { params: { id: string } }) {
  return handleWork(async () => {
    const session = await getServerAuthSession();
    if (!session?.user?.id) return UNAUTHORIZED();
    const ctx = defaultWorkContext();
    const actor = await getWorkActor(session, ctx);
    if (!actor) return NO_ACTOR();
    const body = await readJson(request);
    if (body.operation !== undefined && body.operation !== 'generate') throw new WorkError('INVALID_INPUT', '지원하지 않는 실행입니다.');
    const key = request.headers.get('idempotency-key') ?? body.idempotencyKey;
    const r = await svc.requestGenerate(ctx, actor, params.id, { baseVersion: body.baseVersion, idempotencyKey: key, decisions: body.decisions });
    const base = `/api/work/tasks/${params.id}/runs/${r.run.id}`;
    return ok({ run: r.run, created: r.created, statusUrl: base, executeUrl: `${base}/execute` }, 202);
  });
}
