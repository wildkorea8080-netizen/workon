import { NextRequest, NextResponse } from 'next/server';
import { getServerAuthSession } from '@/lib/auth';
import { actorScopeOr503 } from '@/lib/actor-scope-response';
import { readJsonObject, BAD_BODY_MESSAGE } from '@/lib/request-body';
import { transferLibraryFiles } from '@/lib/my-library';

export const dynamic = 'force-dynamic';

function jsonError(message: string, status: number) {
  return NextResponse.json({ ok: false, error: { message } }, { status });
}

/**
 * 여러 파일·폴더째 다른 자료함으로 복사·옮기기(0298) — `{ space?, to, mode, folder?, ids? | fromFolder? }`(50개까지).
 * 보내기 전에 권한·받는 자리 상한을 한꺼번에 보고, 도중 실패한 파일은 `failed`로 알린다
 */
export async function POST(request: NextRequest) {
  const session = await getServerAuthSession();
  if (!session?.user?.id) return jsonError('인증이 필요합니다.', 401);
  const actor = await actorScopeOr503(session);
  if (actor instanceof Response) return actor;
  if (!actor?.organizationId) return jsonError('소속 기관을 확인할 수 없습니다.', 403);
  const body = await readJsonObject(request);
  if (!body) return jsonError(BAD_BODY_MESSAGE, 400);
  const result = await transferLibraryFiles(
    { userId: actor.userId, organizationId: actor.organizationId, departmentId: actor.departmentId, isAdmin: actor.isAdmin, managesWholeOrganization: actor.managesWholeOrganization },
    { space: body.space, to: body.to, folder: body.folder, mode: body.mode, ids: body.ids, fromFolder: body.fromFolder },
  );
  if (!result.ok) return jsonError(result.message, result.status);
  return NextResponse.json({ ok: true, data: { mode: result.mode, to: result.to, sent: result.sent, failed: result.failed, warnings: result.warnings } });
}
