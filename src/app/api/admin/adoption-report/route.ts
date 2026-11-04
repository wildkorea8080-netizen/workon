import { NextRequest, NextResponse } from 'next/server';
import { getServerAuthSession, isAdminSession } from '@/lib/auth';
import { supabaseAdmin } from '@/lib/supabaseAdmin';
import { getActorScope } from '@/lib/actor-scope';
import { adoptionRows, currentMonth, monthRange, parseMonth, previousMonth, readAdoptionStats } from '@/lib/adoption-report';

export const dynamic = 'force-dynamic';

/**
 * 월별 도입 현황 보고서(0056) — 기관 관리자만. `?month=YYYY-MM`(한국 시간 달, 비우면 이번 달)과 그 전월을 DB 함수로 센다.
 * 범위는 관리자의 관리 범위(자기 부서 + 하위)이고, 숫자만 돌려준다(직원·질문 원문·결과 글 없음).
 */
function jsonError(message: string, status: number) {
  return NextResponse.json({ ok: false, error: { message } }, { status });
}

export async function GET(request: NextRequest) {
  try {
    const session = await getServerAuthSession();
    if (!isAdminSession(session)) return jsonError('관리자 권한이 필요합니다.', 403);
    const actor = await getActorScope(session!);
    if (!actor?.organizationId || !actor.managedDepartmentIds.length) return jsonError('소속 부서가 지정되지 않았습니다.', 403);

    const raw = request.nextUrl.searchParams.get('month');
    const month = raw ? parseMonth(raw) : currentMonth(Date.now());
    if (!month) return jsonError('달은 2026-11처럼 적어 주세요.', 400);
    if (month > currentMonth(Date.now())) return jsonError('아직 오지 않은 달입니다.', 400);
    const previous = previousMonth(month);

    const call = async (m: string) => {
      const { from, to } = monthRange(m);
      const { data, error } = await supabaseAdmin.rpc('adoption_report', {
        p_organization_id: actor.organizationId, p_department_ids: actor.managedDepartmentIds, p_from: from, p_to: to,
      });
      if (error) throw new Error(error.message);
      return readAdoptionStats(data);
    };
    const [current, prior] = await Promise.all([call(month), call(previous)]);
    return NextResponse.json({
      ok: true,
      data: {
        month, previous,
        departments: actor.managedDepartmentIds.length,
        partial: month === currentMonth(Date.now()),
        rows: adoptionRows(current, prior),
      },
    });
  } catch (error) {
    console.error('[adoption-report]', error);
    return jsonError('도입 현황을 집계하지 못했습니다.', 500);
  }
}
