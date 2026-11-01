import { NextResponse } from 'next/server';
import { getServerAuthSession, isAdminSession } from '@/lib/auth';
import { getActorScope } from '@/lib/actor-scope';
import { supabaseAdmin } from '@/lib/supabaseAdmin';
import { MAX_OVERVIEW_RUNS, OVERVIEW_DAYS, summarizeAppRuns, type OverviewApp, type OverviewRun } from '@/lib/apps/run-overview';

export const dynamic = 'force-dynamic';

const fail = (message: string, status: number) => NextResponse.json({ ok: false, error: { message } }, { status });

/**
 * 관리자용 입력형 앱 실행 현황(`src/lib/apps/run-overview.ts`) — 관리 범위 부서의 앱, 최근 30일.
 * **입력·결과·실행한 사람은 읽지도 않는다**: 실행 기록은 단계 이름·상태만 돌려주는 DB 함수 `app_run_states`(0046)로 읽는다.
 */
export async function GET() {
  const session = await getServerAuthSession();
  if (!session?.user?.id) return fail('인증이 필요합니다.', 401);
  if (!isAdminSession(session)) return fail('관리자 권한이 필요합니다.', 403);
  const actor = await getActorScope(session);
  if (!actor?.organizationId || !actor.managedDepartmentIds.length) return fail('관리 범위를 확인할 수 없습니다.', 403);

  const { data: agents, error: agentError } = await supabaseAdmin
    .from('agents')
    .select('id, name, tier, department_id')
    .eq('organization_id', actor.organizationId)
    .in('department_id', actor.managedDepartmentIds)
    .not('app_definition', 'is', null)
    .is('deleted_at', null)
    .limit(500);
  if (agentError) return fail('앱 목록을 불러오지 못했습니다.', 503);
  const rows = (agents ?? []) as Array<{ id: string; name: string; tier: string; department_id: string }>;

  const { data: departments, error: deptError } = await supabaseAdmin
    .from('departments')
    .select('id, name')
    .eq('organization_id', actor.organizationId)
    .in('id', actor.managedDepartmentIds);
  if (deptError) return fail('부서 정보를 불러오지 못했습니다.', 503);
  const deptName = new Map(((departments ?? []) as Array<{ id: string; name: string }>).map((d) => [d.id, d.name]));
  const apps: OverviewApp[] = rows.map((a) => ({ id: a.id, name: a.name, tier: a.tier, departmentName: deptName.get(a.department_id) ?? null }));
  if (!apps.length) return NextResponse.json({ ok: true, data: summarizeAppRuns([], []) });

  const since = new Date(Date.now() - OVERVIEW_DAYS * 24 * 60 * 60 * 1000).toISOString();
  // 단계 이름·상태만 돌려주는 DB 함수(0046) — app_steps의 중간 결과 글은 서버로도 내려오지 않는다
  const { data: runs, error: runError } = await supabaseAdmin.rpc('app_run_states', {
    p_agent_ids: apps.map((a) => a.id),
    p_since: since,
    p_limit: MAX_OVERVIEW_RUNS + 1,
  });
  if (runError) return fail('앱 실행 기록을 불러오지 못했습니다.', 503);
  const list: OverviewRun[] = ((runs ?? []) as Array<{ agent_id: string; created_at: string; has_answer: boolean; steps: unknown }>).map((r) => ({
    agent_id: r.agent_id,
    created_at: r.created_at,
    messages: r.has_answer ? [{ app_steps: r.steps ?? undefined }] : [],
  }));
  const truncated = list.length > MAX_OVERVIEW_RUNS;
  return NextResponse.json({
    ok: true,
    data: summarizeAppRuns(apps, list.slice(0, MAX_OVERVIEW_RUNS), truncated),
  });
}
