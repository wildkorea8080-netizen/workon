import { NextRequest, NextResponse } from 'next/server';
import { clientIpFrom } from '@/lib/ip-access';
import { handleOrgApiCall, orgApiDeps } from '@/lib/org-api/keys';
import { usageSummary } from '@/lib/org-api/reports';

export const dynamic = 'force-dynamic';

/**
 * 기관 통계 읽기 API(0075) — 이용통계. `Authorization: Bearer wo_api_…`(범위 usage)이 유일한 자격이다.
 * `?by=agent|department&from=YYYY-MM-DD&to=YYYY-MM-DD`(한국 날짜, 비우면 최근 30일, 366일까지). 직원별(by=user)은 내지 않는다.
 * 나만의 비서는 이름 없이 묶는다. 숫자만(질문 원문 없음)
 */
export async function GET(request: NextRequest) {
  try {
    const q = request.nextUrl.searchParams;
    const res = await handleOrgApiCall(orgApiDeps(), { authorization: request.headers.get('authorization'), ip: clientIpFrom(request.headers, request.ip) },
      'usage-summary', (ctx) => usageSummary(ctx, { by: q.get('by'), from: q.get('from'), to: q.get('to') }));
    return NextResponse.json(res.body, { status: res.status, headers: { 'Cache-Control': 'no-store', ...res.headers } });
  } catch (error) {
    console.error('[v1 usage-summary]', error instanceof Error ? error.message : error);
    return NextResponse.json({ ok: false, error: { message: '통계를 집계하지 못했습니다. 잠시 뒤 다시 호출해 주세요.' } }, { status: 500 });
  }
}
