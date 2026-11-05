import { NextRequest, NextResponse } from 'next/server';
import { getServerAuthSession, isAdminSession } from '@/lib/auth';
import { getActorScope } from '@/lib/actor-scope';
import { feedbackPeriod, loadFeedbackSummary } from '@/lib/message-feedback';

export const dynamic = 'force-dynamic';

function jsonError(message: string, status: number) {
  return NextResponse.json({ ok: false, error: { message } }, { status });
}

/**
 * 답변 평가 요약(0064) — 기관 관리자만, 관리 범위(자기 부서 + 하위, 최상위면 기관 전체). `?from=YYYY-MM-DD&to=YYYY-MM-DD`(KST, 끝 날 포함, 비우면 최근 30일, 1년까지).
 * 비서별 도움됨·아쉬움·이유 수만 — 질문·답변·직원은 싣지 않는다
 */
export async function GET(request: NextRequest) {
  try {
    const session = await getServerAuthSession();
    if (!isAdminSession(session)) return jsonError('관리자 권한이 필요합니다.', 403);
    const actor = await getActorScope(session!);
    if (!actor?.organizationId || !actor.managedDepartmentIds.length) return jsonError('소속 부서가 지정되지 않았습니다.', 403);
    const period = feedbackPeriod(request.nextUrl.searchParams.get('from'), request.nextUrl.searchParams.get('to'));
    if (!period) return jsonError('기간은 2026-11-01처럼 적고, 1년 안으로 정해 주세요.', 400);
    const summary = await loadFeedbackSummary(
      { organizationId: actor.organizationId, departmentIds: actor.managesWholeOrganization ? null : actor.managedDepartmentIds },
      period
    );
    return NextResponse.json({ ok: true, data: { from: period.from, to: period.to, ...summary } });
  } catch (error) {
    console.error('[feedback-summary]', error instanceof Error ? error.message : error);
    return jsonError('답변 평가를 불러오지 못했습니다. 잠시 뒤 다시 시도해 주세요.', 503);
  }
}
