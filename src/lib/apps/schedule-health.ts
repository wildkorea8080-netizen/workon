// src/lib/apps/schedule-health.ts
// 앱 예약 실행기 상태 점검 — 실행기(pg_cron → /api/cron/app-schedules)가 조용히 멈추는 것을 잡는다.
//
// - 실행기는 불릴 때마다 '살아 있음' 도장(system_settings `app_schedules_runner_heartbeat`)을 찍는다(`recordRunnerHeartbeat`).
// - 하루 한 번 Vercel 예약 작업(`/api/cron/budget-alerts`, pg_cron과 다른 기반)이 도장·지연 예약·멈춘 차지를 본다(`checkScheduleHealth`).
//   pg_cron이 멈췄으면 pg_cron으로는 그 사실을 알 수 없어서 다른 쪽이 본다.
// - 문제가 있으면 운영 기록(system_logs critical — 슈퍼관리자 대시보드에 뜬다)과 슈퍼관리자 메일. 입력값·결과·직원 정보는 싣지 않는다(숫자·시각만).
// - 관리자 화면(`/admin/app-automations`)은 같은 판정으로 실행기 상태와 지연 예약을 보인다.
import { supabaseAdmin } from '@/lib/supabaseAdmin';
import { logSystem } from '@/lib/logger';
import { scheduleRunnerAlertMail, sendScheduleRunnerAlertEmail } from '@/lib/mailer';
import { APP_URL } from '@/lib/config';
import { SCHEDULE_OVERDUE_MS } from './schedule-spec';

export const RUNNER_HEARTBEAT_KEY = 'app_schedules_runner_heartbeat';
/** 실행기는 5분마다 불린다 — 30분(여섯 번) 넘게 소식이 없으면 멈춘 것으로 본다(배포 중 한두 번 빠지는 것은 넘긴다) */
export const RUNNER_STALE_MS = 30 * 60 * 1000;
/** 실행기는 15분 넘은 차지를 다시 잡는다 — 30분 넘게 남은 차지는 실행기가 돌지 않는다는 뜻 */
export const STUCK_CLAIM_MS = 30 * 60 * 1000;

export type ScheduleHealthInput = {
  heartbeatAt: string | null;
  activeCount: number;
  overdueCount: number;
  stuckClaimCount: number;
  nowMs: number;
};

export type ScheduleHealth = {
  /** 실행기가 RUNNER_STALE_MS 안에 불렸는가 (한 번도 안 불렸으면 false) */
  runnerAlive: boolean;
  runnerLastRunAt: string | null;
  activeCount: number;
  overdueCount: number;
  stuckClaimCount: number;
  /** 사람이 봐야 하는 문제(켜진 예약이 있는데 실행기가 멈춤, 1시간 넘게 지난 예약, 멈춘 차지) */
  problems: string[];
};

/** 판정(순수). 켜진 예약이 없으면 실행기가 멈춰도 지금 놓치는 실행은 없어 문제로 치지 않는다(상태에는 남긴다) */
export function assessScheduleHealth(input: ScheduleHealthInput): ScheduleHealth {
  const last = input.heartbeatAt && Number.isFinite(Date.parse(input.heartbeatAt)) ? input.heartbeatAt : null;
  const runnerAlive = last !== null && input.nowMs - Date.parse(last) <= RUNNER_STALE_MS;
  const problems: string[] = [];
  if (!runnerAlive && input.activeCount > 0) {
    problems.push(last ? '예약 실행기가 30분 넘게 불리지 않았습니다.' : '예약 실행기가 한 번도 불린 기록이 없습니다.');
  }
  if (input.overdueCount > 0) problems.push(`예정 시각이 1시간 넘게 지났는데 실행되지 않은 예약이 ${input.overdueCount}개 있습니다.`);
  if (input.stuckClaimCount > 0) problems.push(`30분 넘게 실행 중으로 남은 예약이 ${input.stuckClaimCount}개 있습니다.`);
  return { runnerAlive, runnerLastRunAt: last, activeCount: input.activeCount, overdueCount: input.overdueCount, stuckClaimCount: input.stuckClaimCount, problems };
}

/** 실행기가 불릴 때마다 — 실패해도 실행은 이어 간다(던지지 않음) */
export async function recordRunnerHeartbeat(nowMs: number): Promise<void> {
  const now = new Date(nowMs).toISOString();
  const { error } = await supabaseAdmin.from('system_settings').upsert(
    { key: RUNNER_HEARTBEAT_KEY, value: now, description: '앱 예약 실행기가 마지막으로 불린 때 — 자동으로 바뀐다', updated_at: now },
    { onConflict: 'key' },
  );
  if (error) await logSystem({ level: 'warning', category: 'api', message: '앱 예약 실행기 도장을 남기지 못함', details: { error: error.message.slice(0, 200) } });
}

/** 지금 상태를 DB에서 읽어 판정한다(관리자 화면·점검 공용). 읽기 실패는 던진다 */
export async function readScheduleHealth(nowMs: number, scope?: { organizationId: string; departmentIds: string[] }): Promise<ScheduleHealth> {
  const overdueBefore = new Date(nowMs - SCHEDULE_OVERDUE_MS).toISOString();
  const stuckBefore = new Date(nowMs - STUCK_CLAIM_MS).toISOString();
  const count = (build: (q: any) => any) => {
    let q = supabaseAdmin.from('app_schedules').select('id', { count: 'exact', head: true }).eq('status', 'active');
    if (scope) q = q.eq('organization_id', scope.organizationId).in('department_id', scope.departmentIds);
    return build(q);
  };
  const [beat, active, overdue, stuck] = await Promise.all([
    supabaseAdmin.from('system_settings').select('value').eq('key', RUNNER_HEARTBEAT_KEY).maybeSingle(),
    count((q) => q),
    count((q) => q.lt('next_run_at', overdueBefore)),
    count((q) => q.not('claimed_at', 'is', null).lt('claimed_at', stuckBefore)),
  ]);
  for (const r of [beat, active, overdue, stuck]) if (r.error) throw new Error(`예약 상태를 읽지 못함: ${r.error.message}`);
  return assessScheduleHealth({
    heartbeatAt: (beat.data as { value: string } | null)?.value ?? null,
    activeCount: active.count ?? 0, overdueCount: overdue.count ?? 0, stuckClaimCount: stuck.count ?? 0, nowMs,
  });
}

export interface HealthCheckDeps {
  read(nowMs: number): Promise<ScheduleHealth>;
  superAdminEmails(): Promise<string[]>;
  send(to: string, mail: { subject: string; html: string }): Promise<{ sent: boolean }>;
  log(level: 'info' | 'warning' | 'critical', message: string, details: Record<string, unknown>): Promise<void>;
  now(): number;
}

export type HealthCheckResult = { ok: boolean; problems: string[]; notified: number; error?: string };

/** 하루 한 번 점검 — 던지지 않는다(예산 알림 예약 작업을 막지 않게). 문제가 있으면 critical 기록 + 슈퍼관리자 메일 */
export async function checkScheduleHealth(deps: HealthCheckDeps): Promise<HealthCheckResult> {
  const nowMs = deps.now();
  let health: ScheduleHealth;
  try { health = await deps.read(nowMs); }
  catch (error) {
    const message = error instanceof Error ? error.message.slice(0, 200) : 'unknown';
    await deps.log('warning', '앱 예약 실행기 상태를 점검하지 못함', { error: message });
    return { ok: false, problems: [], notified: 0, error: message };
  }
  const details = { runner_last_run_at: health.runnerLastRunAt, active: health.activeCount, overdue: health.overdueCount, stuck_claims: health.stuckClaimCount };
  if (!health.problems.length) {
    // 켜진 예약이 없어 문제는 아니지만 실행기가 멈춰 있으면 남겨 둔다(예약이 생기기 전에 고칠 수 있게)
    if (!health.runnerAlive) await deps.log('warning', '앱 예약 실행기 소식 없음(켜진 예약 없음)', details);
    return { ok: true, problems: [], notified: 0 };
  }
  await deps.log('critical', '앱 예약 실행기 점검 — 확인 필요', { ...details, problems: health.problems });
  let notified = 0;
  try {
    const mail = scheduleRunnerAlertMail({ problems: health.problems, runnerLastRunAt: health.runnerLastRunAt, activeCount: health.activeCount, checkedAt: new Date(nowMs), superUrl: `${APP_URL}/super/logs` });
    for (const to of await deps.superAdminEmails()) if ((await deps.send(to, mail)).sent) notified++;
  } catch (error) {
    await deps.log('warning', '앱 예약 실행기 점검 메일을 보내지 못함', { error: error instanceof Error ? error.message.slice(0, 200) : 'unknown' });
  }
  return { ok: false, problems: health.problems, notified };
}

export function scheduleHealthDeps(): HealthCheckDeps {
  return {
    read: (nowMs) => readScheduleHealth(nowMs),
    async superAdminEmails() {
      const { data, error } = await supabaseAdmin.from('users').select('email').eq('is_super_admin', true).eq('is_active', true).is('deleted_at', null);
      if (error) throw new Error(error.message);
      return [...new Set(((data ?? []) as Array<{ email: string | null }>).map((u) => (u.email ?? '').trim()).filter((e) => /^[^\s@]+@[^\s@]+$/.test(e)))];
    },
    send: (to, mail) => sendScheduleRunnerAlertEmail(to, mail),
    log: (level, message, details) => logSystem({ level, category: 'api', message, details }),
    now: () => Date.now(),
  };
}
