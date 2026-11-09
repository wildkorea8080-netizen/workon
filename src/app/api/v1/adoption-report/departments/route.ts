import { NextRequest, NextResponse } from 'next/server';
import { clientIpFrom } from '@/lib/ip-access';
import { handleOrgApiCall, orgApiDeps } from '@/lib/org-api/keys';
import { departmentAdoption } from '@/lib/org-api/reports';

export const dynamic = 'force-dynamic';

/**
 * 기관 통계 읽기 API(0075) — 부서별 도입 현황. `Authorization: Bearer wo_api_…`(범위 adoption)이 유일한 자격이다.
 * `?month=YYYY-MM`(한국 시간 달, 비우면 이번 달). 부서마다 자기 부서의 기록만, 숫자만
 */
export async function GET(request: NextRequest) {
  try {
    const res = await handleOrgApiCall(orgApiDeps(), { authorization: request.headers.get('authorization'), ip: clientIpFrom(request.headers, request.ip) },
      'adoption-departments', (ctx) => departmentAdoption(ctx, request.nextUrl.searchParams.get('month')));
    return NextResponse.json(res.body, { status: res.status, headers: { 'Cache-Control': 'no-store', ...res.headers } });
  } catch (error) {
    console.error('[v1 adoption-departments]', error instanceof Error ? error.message : error);
    return NextResponse.json({ ok: false, error: { message: '통계를 집계하지 못했습니다. 잠시 뒤 다시 호출해 주세요.' } }, { status: 500 });
  }
}
