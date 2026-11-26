import { NextResponse, type NextRequest } from 'next/server';
import { getServerAuthSession, isAdminSession } from '@/lib/auth';
import { actorScopeOr503 } from '@/lib/actor-scope-response';
import { AppRunOverviewError, loadAppRunOverview } from '@/lib/apps/run-overview-load';
import { appRunOverviewCsv } from '@/lib/apps/run-overview';
import { feedbackPeriod } from '@/lib/message-feedback';
import { CSV_BOM } from '@/lib/csv-cell';

export const dynamic = 'force-dynamic';

const fail = (message: string, status: number) => NextResponse.json({ ok: false, error: { message } }, { status });

/**
 * 관리자용 입력형 앱 실행 현황(`src/lib/apps/run-overview.ts`) — 관리 범위 부서의 앱. `?from=&to=`(한국 날짜, 끝 날 포함, 비우면 최근 30일, 1년까지 — 2026-11-26),
 * `?format=csv`면 같은 표를 CSV로.
 * **입력·결과·실행한 사람은 읽지도 않는다**: 실행 기록은 단계 이름·상태만 돌려주는 DB 함수 `app_run_states`(0046)로 읽는다
 * (읽기는 `run-overview-load.ts` — 기관 통계 API `/api/v1/app-runs`와 같은 함수).
 */
export async function GET(request?: NextRequest) {
  const session = await getServerAuthSession();
  if (!session?.user?.id) return fail('인증이 필요합니다.', 401);
  if (!isAdminSession(session)) return fail('관리자 권한이 필요합니다.', 403);
  const actor = await actorScopeOr503(session);
  if (actor instanceof Response) return actor;
  if (!actor?.organizationId || !actor.managedDepartmentIds.length) return fail('관리 범위를 확인할 수 없습니다.', 403);
  const params = request?.nextUrl.searchParams;
  const period = feedbackPeriod(params?.get('from') ?? null, params?.get('to') ?? null);
  if (!period) return fail('기간은 2026-11-01처럼 적고, 1년 안으로 정해 주세요.', 400);
  try {
    const data = await loadAppRunOverview(actor.organizationId, actor.managedDepartmentIds, Date.now(), period);
    if (params?.get('format') === 'csv') {
      return new NextResponse(appRunOverviewCsv(data, CSV_BOM), {
        headers: { 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': `attachment; filename="app-runs-${period.from}-${period.to}.csv"`, 'Cache-Control': 'no-store' },
      });
    }
    return NextResponse.json({ ok: true, data });
  } catch (error) {
    if (error instanceof AppRunOverviewError) return fail(error.userMessage, 503);
    throw error;
  }
}
