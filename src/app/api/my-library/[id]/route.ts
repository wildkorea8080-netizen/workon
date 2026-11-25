import { NextRequest, NextResponse } from 'next/server';
import { getServerAuthSession } from '@/lib/auth';
import { libraryActorOr } from '@/lib/my-library-actor';
import { readJsonObject, BAD_BODY_MESSAGE } from '@/lib/request-body';
import { deleteLibraryFile, transferLibraryFile, updateLibraryFile } from '@/lib/my-library';

export const dynamic = 'force-dynamic';

function jsonError(message: string, status: number) {
  return NextResponse.json({ ok: false, error: { message } }, { status });
}

/** 이름 바꾸기·폴더 옮기기 — `{ file_name?, folder?, space? }`(확장자는 그대로). 부서 자료함은 담은 사람·관리자만 */
export async function PATCH(request: NextRequest, { params }: { params: { id: string } }) {
  const actor = await libraryActorOr(await getServerAuthSession());
  if (actor instanceof Response) return actor;
  const body = await readJsonObject(request);
  if (!body) return jsonError(BAD_BODY_MESSAGE, 400);
  const result = await updateLibraryFile(actor, params.id, { file_name: body.file_name, folder: body.folder, space: body.space, share: body.share });
  if (!result.ok) return jsonError(result.message, result.status);
  return NextResponse.json({ ok: true, data: result.file });
}

/**
 * 다른 자료함으로 복사·옮기기(0296) — `{ space?, to, folder?, mode: 'copy' | 'move' }`.
 * 복사는 볼 수 있는 파일이면, 옮기기는 원래 자리에서 바꿀 수 있는 사람만. 받는 자리는 담을 수 있어야 한다(기관 자료함은 기관 전체 관리자만)
 */
export async function POST(request: NextRequest, { params }: { params: { id: string } }) {
  const actor = await libraryActorOr(await getServerAuthSession());
  if (actor instanceof Response) return actor;
  const body = await readJsonObject(request);
  if (!body) return jsonError(BAD_BODY_MESSAGE, 400);
  const result = await transferLibraryFile(actor, params.id, { space: body.space, share: body.share, to: body.to, toShare: body.toShare, folder: body.folder, mode: body.mode });
  if (!result.ok) return jsonError(result.message, result.status);
  return NextResponse.json({ ok: true, data: { file: result.file, mode: result.mode, to: result.to, warning: result.warning ?? null } }, { status: 201 });
}

/** 지우기 — 사본과 행(`?space=department`면 부서 자료함 — 담은 사람·관리자만) */
export async function DELETE(request: NextRequest, { params }: { params: { id: string } }) {
  const actor = await libraryActorOr(await getServerAuthSession());
  if (actor instanceof Response) return actor;
  const result = await deleteLibraryFile(actor, params.id, request.nextUrl.searchParams.get('space') ?? undefined, undefined, request.nextUrl.searchParams.get('share') ?? undefined);
  if (!result.ok) return jsonError(result.message, result.status);
  return NextResponse.json({ ok: true, data: { id: params.id } });
}
