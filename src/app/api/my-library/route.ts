import { NextRequest, NextResponse } from 'next/server';
import { getServerAuthSession } from '@/lib/auth';
import { libraryActorOr } from '@/lib/my-library-actor';
import { readJsonObject, BAD_BODY_MESSAGE } from '@/lib/request-body';
import { listLibrary, saveToLibrary } from '@/lib/my-library';

export const dynamic = 'force-dynamic';

function jsonError(message: string, status: number) {
  return NextResponse.json({ ok: false, error: { message } }, { status });
}

/** 내 자료함(2026-11-24, 0103)·부서 자료함(0106, `?space=department` — 지금 내 부서의 파일). 내 자료함은 내 것만. `?folder=`(빈 글 = 미분류)·`?q=` 이름 찾기·`?cursor=` 쪽 넘기기. 저장소 경로는 싣지 않는다 */
export async function GET(request: NextRequest) {
  const actor = await libraryActorOr(await getServerAuthSession());
  if (actor instanceof Response) return actor;
  const params = request.nextUrl.searchParams;
  const result = await listLibrary(actor, { space: params.get('space') ?? undefined, share: params.get('share') ?? undefined, folder: params.has('folder') ? params.get('folder') : undefined, q: params.get('q'), cursor: params.get('cursor') });
  if (!result.ok) return jsonError(result.message, result.status);
  return NextResponse.json({ ok: true, data: result.data });
}

/** 담기 — `{ kind: 'attachment' | 'generated', id, folder?, space? }`. 내 첨부(읽힌 것)·비서가 만들어 준 파일의 사본을 담는다 */
export async function POST(request: NextRequest) {
  const actor = await libraryActorOr(await getServerAuthSession());
  if (actor instanceof Response) return actor;
  const body = await readJsonObject(request);
  if (!body) return jsonError(BAD_BODY_MESSAGE, 400);
  const result = await saveToLibrary(actor, { kind: body.kind, id: body.id, folder: body.folder, space: body.space, share: body.share });
  if (!result.ok) return jsonError(result.message, result.status);
  return NextResponse.json({ ok: true, data: result.file }, { status: 201 });
}
