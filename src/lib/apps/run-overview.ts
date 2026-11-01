import { appStepsCompleted } from './pipeline';

/**
 * 관리자용 입력형 앱 실행 현황 — 최근 30일, 앱마다 실행 수·결과 상태·자주 멈춘 단계.
 *
 * 알리웍스는 운영자에게 실행 기록(입력·결과·상태)을 보여 준다. 우리는 **입력·결과·실행한 사람을 싣지 않는다** —
 * 직원 질문 원문을 감사 화면에서도 가리는 것과 같은 판단이다(상시 열람이 되면 근로자 감시가 된다).
 * 관리자가 알아야 하는 것은 "어느 앱이 자주 멈추는가, 어느 단계에서"이고, 그건 상태만으로 답할 수 있다.
 *
 * - 대상: 관리 범위(자기 부서 + 하위) 부서의 입력형 앱. **개인 앱은 이름 없이 한 묶음**(앱 수·실행 수·상태)으로만.
 * - 상태 판정은 직원 기록(`history.ts`)과 같다: 단계 기록에 failed·not_run이 있으면 중단, 모두 끝났으면 완료,
 *   단계 기록이 끝나지 않았으면 확인 필요, 답 메시지가 없으면 응답 없음.
 */

export const OVERVIEW_DAYS = 30;
/** 한 번에 읽는 실행 수 — 넘으면 최근 것만 세고 `truncated` */
export const MAX_OVERVIEW_RUNS = 2000;

export type AppRunState = 'saved' | 'interrupted' | 'uncertain' | 'no_response';

export interface OverviewApp {
  id: string;
  name: string;
  tier: string;
  departmentName: string | null;
}

export interface OverviewRun {
  agent_id: string;
  created_at: string;
  /** 대화의 가장 최근 답 하나 — 없으면 빈 배열 */
  messages: Array<{ app_steps?: unknown }>;
}

export interface AppRunCounts {
  runs: number;
  saved: number;
  interrupted: number;
  uncertain: number;
  noResponse: number;
}

export interface AppRunRow extends AppRunCounts {
  agentId: string;
  name: string;
  departmentName: string | null;
  /** 실패로 기록된 단계 이름과 횟수 — 많은 순 3개 */
  failedSteps: Array<{ name: string; count: number }>;
  lastInterruptedAt: string | null;
}

export interface AppRunOverview {
  days: number;
  apps: AppRunRow[];
  /** 개인 앱 묶음 — 이름·실행한 사람 없음 */
  personal: AppRunCounts & { apps: number };
  truncated: boolean;
}

const emptyCounts = (): AppRunCounts => ({ runs: 0, saved: 0, interrupted: 0, uncertain: 0, noResponse: 0 });

/** 실행 하나의 상태와 실패한 단계 이름 */
export function runState(run: OverviewRun): { state: AppRunState; failedSteps: string[] } {
  const message = run.messages[0];
  if (!message) return { state: 'no_response', failedSteps: [] };
  const raw = Array.isArray(message.app_steps) ? (message.app_steps as Array<{ name?: unknown; status?: unknown }>) : [];
  if (!raw.length) return { state: 'saved', failedSteps: [] };
  const failedSteps = raw
    .filter((step) => step?.status === 'failed' && typeof step.name === 'string')
    .map((step) => (step.name as string).slice(0, 40));
  if (raw.some((step) => step?.status === 'failed' || step?.status === 'not_run')) return { state: 'interrupted', failedSteps };
  return { state: appStepsCompleted(raw) ? 'saved' : 'uncertain', failedSteps: [] };
}

function count(counts: AppRunCounts, state: AppRunState) {
  counts.runs += 1;
  if (state === 'saved') counts.saved += 1;
  else if (state === 'interrupted') counts.interrupted += 1;
  else if (state === 'uncertain') counts.uncertain += 1;
  else counts.noResponse += 1;
}

export function summarizeAppRuns(apps: OverviewApp[], runs: OverviewRun[], truncated = false): AppRunOverview {
  const rows = new Map<string, AppRunRow & { steps: Map<string, number> }>();
  const personalIds = new Set<string>();
  for (const app of apps) {
    if (app.tier === 'personal') { personalIds.add(app.id); continue; }
    rows.set(app.id, { agentId: app.id, name: app.name, departmentName: app.departmentName, ...emptyCounts(), failedSteps: [], lastInterruptedAt: null, steps: new Map() });
  }
  const personal = { ...emptyCounts(), apps: personalIds.size };
  for (const run of runs) {
    const { state, failedSteps } = runState(run);
    if (personalIds.has(run.agent_id)) { count(personal, state); continue; }
    const row = rows.get(run.agent_id);
    if (!row) continue;
    count(row, state);
    if (state === 'interrupted' && (!row.lastInterruptedAt || run.created_at > row.lastInterruptedAt)) row.lastInterruptedAt = run.created_at;
    for (const name of failedSteps) row.steps.set(name, (row.steps.get(name) ?? 0) + 1);
  }
  const list = [...rows.values()].map(({ steps, ...row }) => ({
    ...row,
    failedSteps: [...steps.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, 3).map(([name, n]) => ({ name, count: n })),
  }));
  // 중단이 많은 앱을 먼저, 같으면 실행이 많은 순, 이름 순
  list.sort((a, b) => b.interrupted - a.interrupted || b.runs - a.runs || a.name.localeCompare(b.name));
  return { days: OVERVIEW_DAYS, apps: list, personal, truncated };
}
