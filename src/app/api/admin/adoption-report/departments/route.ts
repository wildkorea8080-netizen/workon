import { NextRequest, NextResponse } from 'next/server';
import { getServerAuthSession, isAdminSession } from '@/lib/auth';
import { supabaseAdmin } from '@/lib/supabaseAdmin';
import { getActorScope } from '@/lib/actor-scope';
import { currentMonth, monthRange, parseMonth } from '@/lib/adoption-report';
import { readDepartmentAdoption } from '@/lib/department-adoption';

export const dynamic = 'force-dynamic';

function jsonError(message: string, status: number) {
  return NextResponse.json({ ok: false, error: { message } }, { status });
}

/**
 * 부서별 도입 현황(0065) — 기관 관리자만, 관리 범위(자기 부서 + 하위)의 부서마다 한 줄. `?month=YYYY-MM`(KST, 비우면 이번 달).
 * 부서마다 자기 부서의 기록만(하위 부서를 올려 더하지 않음). 숫자만 돌려준다
 */
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
    const { from, to } = monthRange(month);
    const { data, error } = await supabaseAdmin.rpc('adoption_by_department', {
      p_organization_id: actor.organizationId, p_department_ids: actor.managedDepartmentIds, p_from: from, p_to: to,
    });
    if (error) throw new Error(error.message);
    return NextResponse.json({ ok: true, data: { month, partial: month === currentMonth(Date.now()), departments: readDepartmentAdoption(data) } });
  } catch (error) {
    console.error('[adoption-report/departments]', error instanceof Error ? error.message : error);
    return jsonError('부서별 도입 현황을 집계하지 못했습니다.', 500);
  }
}
