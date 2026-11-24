import { NextResponse } from 'next/server';
import { getServerAuthSession, isAdminSession } from '@/lib/auth';
import { managedDepartmentIdsOr503 } from '@/lib/managed-scope-response';
import { listSharedConversations } from '@/lib/shared-conversations-admin';
import { actorScopeOr503 } from '@/lib/actor-scope-response';
import { orgSwitchView, readOrgSwitch } from '@/lib/apps/webhook-switch';

export const dynamic = 'force-dynamic';

const fail = (message: string, status: number) =>
  NextResponse.json({ ok: false, error: { message } }, { status });

/**
 * 관리 범위 직원이 공개 링크로 공유 중인 대화 — 누가·어느 부서·언제 공유했는지만(제목·내용·링크 주소 없음).
 */
export async function GET() {
  try {
    const session = await getServerAuthSession();
    if (!session?.user?.id || !isAdminSession(session)) return fail('관리자 권한이 필요합니다.', 403);

    const departmentId = session.user.departmentId;
    if (!departmentId) return fail('부서 정보를 찾을 수 없습니다.', 403);

    const managed = await managedDepartmentIdsOr503(departmentId);
    if (managed instanceof Response) return managed;
    const listed = await listSharedConversations(managed);
    // 못 읽은 것을 '공유 중인 대화 없음'으로 보이지 않는다
    if ('error' in listed) return fail('공유 중인 대화를 불러오지 못했습니다. 잠시 뒤 다시 시도해 주세요.', 503);

    // 기관 전체 '대화 공개 링크' 스위치(0098) — 못 읽으면 null(화면이 그렇다고 알림, 목록은 그대로 보인다)
    // (소속을 못 읽어도 목록은 막지 않는다 — 스위치만 '읽지 못함')
    let shareSwitch = null;
    try {
      const actor = await actorScopeOr503(session);
      if (actor && !(actor instanceof Response) && actor.organizationId) {
        shareSwitch = orgSwitchView(await readOrgSwitch('shares', actor.organizationId), actor);
      }
    } catch {
      shareSwitch = null;
    }

    return NextResponse.json({ ok: true, data: listed.rows, truncated: listed.truncated, shareSwitch });
  } catch (error) {
    console.error('[admin shared-conversations GET]', error);
    return fail('서버 오류가 발생했습니다.', 500);
  }
}
