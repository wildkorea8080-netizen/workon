import { NextRequest, NextResponse } from 'next/server';
import { getServerAuthSession } from '@/lib/auth';
import { actorScopeOr503 } from '@/lib/actor-scope-response';
import { readJsonObject, BAD_BODY_MESSAGE } from '@/lib/request-body';
import { moveLibraryFolder } from '@/lib/my-library';

export const dynamic = 'force-dynamic';

function jsonError(message: string, status: number) {
  return NextResponse.json({ ok: false, error: { message } }, { status });
}

/**
 * 폴더째 이름 바꾸기·옮기기(0294) — `{ space?, from, to }`. 그 폴더와 그 아래 폴더의 파일을 모두 새 경로 아래로.
 * 내 자료함은 나, 부서 자료함은 관리자, 기관 자료함은 기관 전체 관리자만
 */
export async function PATCH(request: NextRequest) {
  const session = await getServerAuthSession();
  if (!session?.user?.id) return jsonError('인증이 필요합니다.', 401);
  const actor = await actorScopeOr503(session);
  if (actor instanceof Response) return actor;
  if (!actor?.organizationId) return jsonError('소속 기관을 확인할 수 없습니다.', 403);
  const body = await readJsonObject(request);
  if (!body) return jsonError(BAD_BODY_MESSAGE, 400);
  const result = await moveLibraryFolder(
    { userId: actor.userId, organizationId: actor.organizationId, departmentId: actor.departmentId, isAdmin: actor.isAdmin, managesWholeOrganization: actor.managesWholeOrganization },
    { space: body.space, from: body.from, to: body.to },
  );
  if (!result.ok) return jsonError(result.message, result.status);
  return NextResponse.json({ ok: true, data: { moved: result.moved, folders: result.folders } });
}
