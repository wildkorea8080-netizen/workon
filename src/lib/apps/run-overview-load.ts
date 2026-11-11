// src/lib/apps/run-overview-load.ts
// 입력형 앱 실행 현황 읽기(DB) — 관리자 화면(`/api/admin/app-overview`)과 기관 통계 API(`/api/v1/app-runs`, 2026-11-11)가 함께 쓴다(셈이 두 벌이 되지 않게).
// 실행 기록은 단계 이름·상태만 돌려주는 DB 함수 `app_run_states`(0046)로 읽는다 — 입력·결과·실행한 사람은 서버로도 내려오지 않는다.
import { supabaseAdmin } from '@/lib/supabaseAdmin';
import { MAX_OVERVIEW_RUNS, OVERVIEW_DAYS, summarizeAppRuns, type AppRunOverview, type OverviewApp, type OverviewRun } from './run-overview';

export class AppRunOverviewError extends Error {
  constructor(public readonly userMessage: string, detail: string) { super(detail); }
}

/** 기관·부서 범위의 입력형 앱 실행 현황(최근 30일). 읽지 못하면 `AppRunOverviewError`(화면에 보일 안내 포함) */
export async function loadAppRunOverview(organizationId: string, departmentIds: string[], nowMs = Date.now()): Promise<AppRunOverview> {
  const { data: agents, error: agentError } = await supabaseAdmin
    .from('agents')
    .select('id, name, tier, department_id')
    .eq('organization_id', organizationId)
    .in('department_id', departmentIds)
    .not('app_definition', 'is', null)
    .is('deleted_at', null)
    .limit(500);
  if (agentError) throw new AppRunOverviewError('앱 목록을 불러오지 못했습니다.', `agents: ${agentError.message}`);
  const rows = (agents ?? []) as Array<{ id: string; name: string; tier: string; department_id: string }>;

  const { data: departments, error: deptError } = await supabaseAdmin
    .from('departments')
    .select('id, name')
    .eq('organization_id', organizationId)
    .in('id', departmentIds);
  if (deptError) throw new AppRunOverviewError('부서 정보를 불러오지 못했습니다.', `departments: ${deptError.message}`);
  const deptName = new Map(((departments ?? []) as Array<{ id: string; name: string }>).map((d) => [d.id, d.name]));
  const apps: OverviewApp[] = rows.map((a) => ({ id: a.id, name: a.name, tier: a.tier, departmentName: deptName.get(a.department_id) ?? null }));
  if (!apps.length) return summarizeAppRuns([], []);

  const since = new Date(nowMs - OVERVIEW_DAYS * 24 * 60 * 60 * 1000).toISOString();
  // 단계 이름·상태만 돌려주는 DB 함수(0046) — app_steps의 중간 결과 글은 서버로도 내려오지 않는다
  const { data: runs, error: runError } = await supabaseAdmin.rpc('app_run_states', {
    p_agent_ids: apps.map((a) => a.id),
    p_since: since,
    p_limit: MAX_OVERVIEW_RUNS + 1,
  });
  if (runError) throw new AppRunOverviewError('앱 실행 기록을 불러오지 못했습니다.', `app_run_states: ${runError.message}`);
  const list: OverviewRun[] = ((runs ?? []) as Array<{ agent_id: string; created_at: string; has_answer: boolean; steps: unknown }>).map((r) => ({
    agent_id: r.agent_id,
    created_at: r.created_at,
    messages: r.has_answer ? [{ app_steps: r.steps ?? undefined }] : [],
  }));
  const truncated = list.length > MAX_OVERVIEW_RUNS;
  return summarizeAppRuns(apps, list.slice(0, MAX_OVERVIEW_RUNS), truncated);
}
