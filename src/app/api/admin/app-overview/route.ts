import { NextResponse } from 'next/server';
import { getServerAuthSession, isAdminSession } from '@/lib/auth';
import { getActorScope } from '@/lib/actor-scope';
import { AppRunOverviewError, loadAppRunOverview } from '@/lib/apps/run-overview-load';

export const dynamic = 'force-dynamic';

const fail = (message: string, status: number) => NextResponse.json({ ok: false, error: { message } }, { status });

/**
 * 관리자용 입력형 앱 실행 현황(`src/lib/apps/run-overview.ts`) — 관리 범위 부서의 앱, 최근 30일.
 * **입력·결과·실행한 사람은 읽지도 않는다**: 실행 기록은 단계 이름·상태만 돌려주는 DB 함수 `app_run_states`(0046)로 읽는다
 * (읽기는 `run-overview-load.ts` — 기관 통계 API `/api/v1/app-runs`와 같은 함수).
 */
export async function GET() {
  const session = await getServerAuthSession();
  if (!session?.user?.id) return fail('인증이 필요합니다.', 401);
  if (!isAdminSession(session)) return fail('관리자 권한이 필요합니다.', 403);
  const actor = await getActorScope(session);
  if (!actor?.organizationId || !actor.managedDepartmentIds.length) return fail('관리 범위를 확인할 수 없습니다.', 403);
  try {
    return NextResponse.json({ ok: true, data: await loadAppRunOverview(actor.organizationId, actor.managedDepartmentIds) });
  } catch (error) {
    if (error instanceof AppRunOverviewError) return fail(error.userMessage, 503);
    throw error;
  }
}
