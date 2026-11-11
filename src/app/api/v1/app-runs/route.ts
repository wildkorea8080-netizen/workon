import { NextRequest, NextResponse } from 'next/server';
import { clientIpFrom } from '@/lib/ip-access';
import { handleOrgApiCall, orgApiDeps } from '@/lib/org-api/keys';
import { appRunsReport } from '@/lib/org-api/reports';

export const dynamic = 'force-dynamic';

/**
 * 기관 통계 읽기 API(0075·0086) — 입력형 앱 실행 현황(최근 30일, 개인 앱은 이름 없이). `Authorization: Bearer wo_api_…`(범위 usage)이 유일한 자격이다.
 * 관리자 통계 화면과 같은 읽기 함수. 숫자만(질문·답변·결과 글·직원 없음)
 */
export async function GET(request: NextRequest) {
  try {
    const res = await handleOrgApiCall(orgApiDeps(), { authorization: request.headers.get('authorization'), ip: clientIpFrom(request.headers, request.ip) },
      'app-runs', (ctx) => appRunsReport(ctx));
    return NextResponse.json(res.body, { status: res.status, headers: { 'Cache-Control': 'no-store', ...res.headers } });
  } catch (error) {
    console.error('[v1 app-runs]', error instanceof Error ? error.message : error);
    return NextResponse.json({ ok: false, error: { message: '통계를 집계하지 못했습니다. 잠시 뒤 다시 호출해 주세요.' } }, { status: 500 });
  }
}
