import { NextResponse } from 'next/server';
import { getServerAuthSession, isAdminSession } from '@/lib/auth';
import { getManagedDepartmentIds } from '@/lib/department-scope';
import { listSharedConversations } from '@/lib/shared-conversations-admin';

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

    const managed = await getManagedDepartmentIds(departmentId);
    const listed = await listSharedConversations(managed);
    // 못 읽은 것을 '공유 중인 대화 없음'으로 보이지 않는다
    if ('error' in listed) return fail('공유 중인 대화를 불러오지 못했습니다. 잠시 뒤 다시 시도해 주세요.', 503);

    return NextResponse.json({ ok: true, data: listed.rows, truncated: listed.truncated });
  } catch (error) {
    console.error('[admin shared-conversations GET]', error);
    return fail('서버 오류가 발생했습니다.', 500);
  }
}
