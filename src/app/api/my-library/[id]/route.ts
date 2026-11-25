import { NextRequest, NextResponse } from 'next/server';
import { getServerAuthSession } from '@/lib/auth';
import { actorScopeOr503 } from '@/lib/actor-scope-response';
import { readJsonObject, BAD_BODY_MESSAGE } from '@/lib/request-body';
import { deleteLibraryFile, transferLibraryFile, updateLibraryFile } from '@/lib/my-library';

export const dynamic = 'force-dynamic';

function jsonError(message: string, status: number) {
  return NextResponse.json({ ok: false, error: { message } }, { status });
}

async function actorOf(session: Awaited<ReturnType<typeof getServerAuthSession>>) {
  if (!session?.user?.id) return jsonError('인증이 필요합니다.', 401);
  const actor = await actorScopeOr503(session);
  if (actor instanceof Response) return actor;
  if (!actor?.organizationId) return jsonError('소속 기관을 확인할 수 없습니다.', 403);
  return { userId: actor.userId, organizationId: actor.organizationId, departmentId: actor.departmentId, isAdmin: actor.isAdmin, managesWholeOrganization: actor.managesWholeOrganization };
}

/** 이름 바꾸기·폴더 옮기기 — `{ file_name?, folder?, space? }`(확장자는 그대로). 부서 자료함은 담은 사람·관리자만 */
export async function PATCH(request: NextRequest, { params }: { params: { id: string } }) {
  const actor = await actorOf(await getServerAuthSession());
  if (actor instanceof Response) return actor;
  const body = await readJsonObject(request);
  if (!body) return jsonError(BAD_BODY_MESSAGE, 400);
  const result = await updateLibraryFile(actor, params.id, { file_name: body.file_name, folder: body.folder, space: body.space });
  if (!result.ok) return jsonError(result.message, result.status);
  return NextResponse.json({ ok: true, data: result.file });
}

/**
 * 다른 자료함으로 복사·옮기기(0296) — `{ space?, to, folder?, mode: 'copy' | 'move' }`.
 * 복사는 볼 수 있는 파일이면, 옮기기는 원래 자리에서 바꿀 수 있는 사람만. 받는 자리는 담을 수 있어야 한다(기관 자료함은 기관 전체 관리자만)
 */
export async function POST(request: NextRequest, { params }: { params: { id: string } }) {
  const actor = await actorOf(await getServerAuthSession());
  if (actor instanceof Response) return actor;
  const body = await readJsonObject(request);
  if (!body) return jsonError(BAD_BODY_MESSAGE, 400);
  const result = await transferLibraryFile(actor, params.id, { space: body.space, to: body.to, folder: body.folder, mode: body.mode });
  if (!result.ok) return jsonError(result.message, result.status);
  return NextResponse.json({ ok: true, data: { file: result.file, mode: result.mode, to: result.to, warning: result.warning ?? null } }, { status: 201 });
}

/** 지우기 — 사본과 행(`?space=department`면 부서 자료함 — 담은 사람·관리자만) */
export async function DELETE(request: NextRequest, { params }: { params: { id: string } }) {
  const actor = await actorOf(await getServerAuthSession());
  if (actor instanceof Response) return actor;
  const result = await deleteLibraryFile(actor, params.id, request.nextUrl.searchParams.get('space') ?? undefined);
  if (!result.ok) return jsonError(result.message, result.status);
  return NextResponse.json({ ok: true, data: { id: params.id } });
}
