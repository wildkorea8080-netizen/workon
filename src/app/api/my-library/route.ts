import { NextRequest, NextResponse } from 'next/server';
import { getServerAuthSession } from '@/lib/auth';
import { actorScopeOr503 } from '@/lib/actor-scope-response';
import { readJsonObject, BAD_BODY_MESSAGE } from '@/lib/request-body';
import { listLibrary, saveToLibrary } from '@/lib/my-library';

export const dynamic = 'force-dynamic';

function jsonError(message: string, status: number) {
  return NextResponse.json({ ok: false, error: { message } }, { status });
}

async function actorOf(session: Awaited<ReturnType<typeof getServerAuthSession>>) {
  if (!session?.user?.id) return jsonError('인증이 필요합니다.', 401);
  // 소속을 모르면 거절한다 — 추측해서 배정하지 않는다
  const actor = await actorScopeOr503(session);
  if (actor instanceof Response) return actor;
  if (!actor?.organizationId) return jsonError('소속 기관을 확인할 수 없습니다.', 403);
  return { userId: actor.userId, organizationId: actor.organizationId, departmentId: actor.departmentId, isAdmin: actor.isAdmin };
}

/** 내 자료함(2026-11-24, 0103)·부서 자료함(0106, `?space=department` — 지금 내 부서의 파일). 내 자료함은 내 것만. `?folder=`(빈 글 = 미분류)·`?q=` 이름 찾기·`?cursor=` 쪽 넘기기. 저장소 경로는 싣지 않는다 */
export async function GET(request: NextRequest) {
  const actor = await actorOf(await getServerAuthSession());
  if (actor instanceof Response) return actor;
  const params = request.nextUrl.searchParams;
  const result = await listLibrary(actor, { space: params.get('space') ?? undefined, folder: params.has('folder') ? params.get('folder') : undefined, q: params.get('q'), cursor: params.get('cursor') });
  if (!result.ok) return jsonError(result.message, result.status);
  return NextResponse.json({ ok: true, data: result.data });
}

/** 담기 — `{ kind: 'attachment' | 'generated', id, folder?, space? }`. 내 첨부(읽힌 것)·비서가 만들어 준 파일의 사본을 담는다 */
export async function POST(request: NextRequest) {
  const actor = await actorOf(await getServerAuthSession());
  if (actor instanceof Response) return actor;
  const body = await readJsonObject(request);
  if (!body) return jsonError(BAD_BODY_MESSAGE, 400);
  const result = await saveToLibrary(actor, { kind: body.kind, id: body.id, folder: body.folder, space: body.space });
  if (!result.ok) return jsonError(result.message, result.status);
  return NextResponse.json({ ok: true, data: result.file }, { status: 201 });
}
