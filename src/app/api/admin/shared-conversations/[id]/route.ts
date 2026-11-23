import { NextRequest, NextResponse } from 'next/server';
import { getServerAuthSession, isAdminSession } from '@/lib/auth';
import { managedDepartmentIdsOr503 } from '@/lib/managed-scope-response';
import { cleanStopReason, stopSharedConversation, STOP_REASON_MIN } from '@/lib/shared-conversations-admin';

export const dynamic = 'force-dynamic';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const fail = (message: string, status: number) =>
  NextResponse.json({ ok: false, error: { message } }, { status });

/**
 * 관리 범위 직원의 공개 링크 중단 — 사유를 적어야 한다(보안 로그에 남는다). 주소를 버리므로 되살릴 수 없다.
 */
export async function DELETE(request: NextRequest, { params }: { params: { id: string } }) {
  try {
    const session = await getServerAuthSession();
    if (!session?.user?.id || !isAdminSession(session)) return fail('관리자 권한이 필요합니다.', 403);

    const departmentId = session.user.departmentId;
    if (!departmentId) return fail('부서 정보를 찾을 수 없습니다.', 403);
    if (!UUID.test(params.id)) return fail('공유 중인 대화를 찾을 수 없습니다. 이미 중단됐을 수 있습니다.', 404);

    const body = (await request.json().catch(() => null)) as { reason?: unknown } | null;
    const reason = cleanStopReason(body?.reason);
    if (!reason) return fail(`중단 사유를 ${STOP_REASON_MIN}자 이상 적어 주세요.`, 400);

    const managed = await managedDepartmentIdsOr503(departmentId);
    if (managed instanceof Response) return managed;
    const result = await stopSharedConversation({
      conversationId: params.id,
      managedDepartmentIds: managed,
      actorId: session.user.id,
      actorDepartmentId: departmentId,
      reason,
      impersonating: session.user.isImpersonating === true,
    });
    if (!result.ok) return fail(result.message, result.status);

    return NextResponse.json({ ok: true, data: { id: params.id, isShared: false } });
  } catch (error) {
    console.error('[admin shared-conversations DELETE]', error);
    return fail('서버 오류가 발생했습니다.', 500);
  }
}
