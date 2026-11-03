// src/lib/apps/schedules.ts
// 입력형 앱 예약 실행(0048). 직원이 저장한 입력으로 앱을 정해진 시각(KST)에 자동 실행한다 — 알리웍스 Agent Builder의 스케줄 트리거에 대응.
//
// - 실행은 **예약한 직원의 권한·사용량**으로 한다: 그 사람의 세션 꼴을 만들어 대화 실행기(`prepareTurn`·`streamTurn`)를 그대로 태운다.
//   권한(canUseAgent)·기관 한도·모델 정책·금지어 검사·사용 기록·대화 저장이 손으로 실행할 때와 같다. 결과는 그 직원의 대화로 남고(제목 앞 `[예약]`),
//   앱 실행 기록(`/apps/history`)에 함께 보인다.
// - **중복 방지**: 실행기는 다음 실행 시각이 지난 활성 예약을 조건부 갱신(`claimed_at`)으로 차지한 뒤에만 실행한다. 두 실행기가 동시에 돌아도 한 번만.
//   차지가 15분 넘게 남아 있으면(함수가 죽음) 멈춘 차지로 보고 다시 잡는다. 같은 시각이 두 번 돌지 않게 다음 시각은 '지금 뒤'로 센다.
// - **멈춤**: 앱 설정이 바뀌었거나(판 다름) 앱을 쓸 수 없거나(권한·삭제) 직원 계정을 쓸 수 없으면 예약을 멈추고 이유를 적는다. 그 밖의 실패(한도·모델 오류)는
//   다음 차례에 다시 하고, 연속 3회 실패하면 멈춘다. 실패·멈춤은 예약한 직원에게 메일로 알린다(메일이 설정돼 있을 때 — 주소는 기록에 남기지 않는다).
// - 파일 입력은 예약할 수 없다(첨부는 한 대화에 묶이고 서명 주소가 짧다). 실행기는 `/api/cron/app-schedules`(CRON_SECRET)이고 pg_cron이 5분마다 부른다.
//   Vercel Hobby 예약 작업은 하루 한 번·2개까지라 쓰지 않는다 — docs/benchmarks/allganize/APP_SCHEDULES.md.
import type { Session } from 'next-auth';
import { supabaseAdmin } from '@/lib/supabaseAdmin';
import { APP_URL } from '@/lib/config';
import { logSystem } from '@/lib/logger';
import { isMailConfigured, scheduleFailureMail, sendScheduleFailureEmail } from '@/lib/mailer';
import { prepareTurn } from '@/lib/assistant/prepare';
import { streamTurn } from '@/lib/assistant/stream';
import type { PrepareOutcome, PreparedTurn, SendEvent } from '@/lib/assistant/types';
import { describeSchedule, nextRunAt, specOfRow, type AppScheduleRowLike } from './schedule-spec';

export const SCHEDULE_MAX_CONSECUTIVE_FAILURES = 3;
export const SCHEDULE_CLAIM_STALE_MS = 15 * 60 * 1000;
/** 한 번 불릴 때 쓰는 시간 예산 — 라우트 `maxDuration` 300초 안에서 실행 하나(단계 3개 + 최종, 최대 수 분)가 끝날 여유를 둔다 */
export const SCHEDULE_RUN_BUDGET_MS = 180_000;
export const SCHEDULE_BATCH = 3;
export const PAUSED_AFTER_FAILURES = `연속 ${SCHEDULE_MAX_CONSECUTIVE_FAILURES}회 실패해 예약을 멈췄습니다. 입력과 앱 설정을 확인한 뒤 다시 켜 주세요.`;
export const PAUSED_APP_CHANGED = '앱 설정이 바뀌어 예약을 멈췄습니다. 앱을 다시 열어 새로 예약해 주세요.';
export const PAUSED_APP_UNAVAILABLE = '앱을 쓸 수 없어(권한 없음 또는 삭제됨) 예약을 멈췄습니다.';
export const PAUSED_USER_UNAVAILABLE = '예약한 직원의 계정을 쓸 수 없어 예약을 멈췄습니다.';
export const PAUSED_DEPARTMENT_CHANGED = '소속 부서가 바뀌어 예약을 멈췄습니다. 예약을 다시 만들어 주세요.';
export const SCHEDULE_TITLE_PREFIX = '[예약] ';

export type AppScheduleRow = AppScheduleRowLike & {
  user_id: string; department_id: string; organization_id: string; claimed_at: string | null; updated_at: string;
};

export type ScheduleOutcome =
  | { kind: 'completed'; conversationId: string | null }
  | { kind: 'failed'; error: string; conversationId?: string | null }
  | { kind: 'pause'; reason: string };

export type SchedulePatch = Partial<Pick<AppScheduleRow,
  'status' | 'paused_reason' | 'next_run_at' | 'claimed_at' | 'last_run_at' | 'last_status' | 'last_error' | 'last_conversation_id' | 'consecutive_failures' | 'run_count' | 'updated_at'>>;

export interface ScheduleDeps {
  /** 지금 실행할 차례인 활성 예약(차지되지 않았거나 멈춘 차지) — 다음 실행 시각 순 */
  due(nowMs: number, limit: number): Promise<AppScheduleRow[]>;
  /** 조건부로 차지했으면 true. 다른 실행기가 먼저 잡았으면 false */
  claim(id: string, nowMs: number): Promise<boolean>;
  execute(row: AppScheduleRow): Promise<ScheduleOutcome>;
  finish(id: string, patch: SchedulePatch): Promise<void>;
  notifyFailure(row: AppScheduleRow, info: { error: string; paused: boolean; nextRunAt: string | null }): Promise<void>;
  log(level: 'info' | 'warning' | 'error', message: string, details: Record<string, unknown>, organizationId: string): Promise<void>;
  now(): number;
}

export interface ScheduleRun {
  /** 살펴본 예약 수 */
  checked: number;
  completed: number;
  failed: number;
  /** 이번 실행으로 멈춘 예약 수(실패 누적·앱 변경 등) */
  paused: number;
  /** 다른 실행기가 먼저 차지해 건너뜀 */
  skipped: number;
  /** 시간 예산에 닿아 남은 예약을 다음 호출에 넘겼다 */
  partial: boolean;
}

const errorText = (error: unknown) => (error instanceof Error ? error.message.slice(0, 300) : '알 수 없는 오류');

/** 실행 결과 → 예약 행 갱신(순수). 다음 시각은 언제나 앞으로 민다 — 실패한 차례를 바로 다시 돌리지 않는다(같은 오류로 모델만 다시 부른다) */
export function finishPatch(row: AppScheduleRow, outcome: ScheduleOutcome, nowMs: number): SchedulePatch {
  const now = new Date(nowMs).toISOString();
  const base: SchedulePatch = {
    claimed_at: null, last_run_at: now, updated_at: now, run_count: row.run_count + 1,
    next_run_at: nextRunAt(specOfRow(row), nowMs).toISOString(),
  };
  if (outcome.kind === 'completed') {
    return { ...base, last_status: 'completed', last_error: null, last_conversation_id: outcome.conversationId ?? null, consecutive_failures: 0 };
  }
  if (outcome.kind === 'pause') {
    return { ...base, last_status: 'failed', last_error: outcome.reason, consecutive_failures: row.consecutive_failures + 1, status: 'paused', paused_reason: outcome.reason };
  }
  const failures = row.consecutive_failures + 1;
  return {
    ...base, last_status: 'failed', last_error: outcome.error.slice(0, 300), last_conversation_id: outcome.conversationId ?? null, consecutive_failures: failures,
    ...(failures >= SCHEDULE_MAX_CONSECUTIVE_FAILURES ? { status: 'paused' as const, paused_reason: PAUSED_AFTER_FAILURES } : {}),
  };
}

/** 차례가 된 예약을 차지해 하나씩 실행한다. 한 예약의 실패가 다른 예약을 막지 않는다 */
export async function runDueSchedules(deps: ScheduleDeps): Promise<ScheduleRun> {
  const started = deps.now();
  const result: ScheduleRun = { checked: 0, completed: 0, failed: 0, paused: 0, skipped: 0, partial: false };
  const rows = await deps.due(started, SCHEDULE_BATCH);
  for (const row of rows) {
    if (deps.now() - started > SCHEDULE_RUN_BUDGET_MS) { result.partial = true; break; }
    result.checked++;
    let claimed = false;
    try { claimed = await deps.claim(row.id, deps.now()); }
    catch (error) { await deps.log('warning', '앱 예약을 차지하지 못함', { schedule_id: row.id, error: errorText(error) }, row.organization_id); continue; }
    if (!claimed) { result.skipped++; continue; }

    let outcome: ScheduleOutcome;
    try { outcome = await deps.execute(row); }
    catch (error) { outcome = { kind: 'failed', error: errorText(error) }; }

    const patch = finishPatch(row, outcome, deps.now());
    try { await deps.finish(row.id, patch); }
    catch (error) {
      // 차지가 남아 15분 뒤 다시 잡힌다 — 끝난 실행이 한 번 더 돌 수 있어 기록을 남긴다
      await deps.log('error', '앱 예약 실행 결과를 저장하지 못함', { schedule_id: row.id, outcome: outcome.kind, error: errorText(error) }, row.organization_id);
    }

    if (outcome.kind === 'completed') { result.completed++; continue; }
    const paused = patch.status === 'paused';
    if (paused) result.paused++; else result.failed++;
    const error = outcome.kind === 'pause' ? outcome.reason : outcome.error;
    await deps.log('warning', paused ? '앱 예약을 멈춤' : '앱 예약 실행 실패', { schedule_id: row.id, agent_id: row.agent_id, reason: error.slice(0, 200), paused }, row.organization_id);
    try { await deps.notifyFailure(row, { error, paused, nextRunAt: patch.next_run_at ?? null }); }
    catch (notifyError) { await deps.log('warning', '앱 예약 실패 알림을 보내지 못함', { schedule_id: row.id, error: errorText(notifyError) }, row.organization_id); }
  }
  return result;
}

type ScheduleUser = { id: string; email: string | null; role: string | null; department_id: string | null; is_active: boolean | null; deleted_at: string | null };

export interface ExecuteIo {
  loadUser(userId: string): Promise<ScheduleUser | null>;
  prepare(session: Session, body: Record<string, unknown>): Promise<PrepareOutcome>;
  stream(turn: PreparedTurn, send: SendEvent): Promise<void>;
  /** 대화 제목 앞에 `[예약] `을 붙인다(실행 기록에서 예약 실행을 가르게) */
  retitle(conversationId: string): Promise<void>;
}

/**
 * 예약 하나를 그 직원으로 실행한다. 거절 상태 403·404(앱을 쓸 수 없음)·409(앱 판 바뀜)는 '멈춤', 그 밖(한도 429·검사 400·모델 오류)은 '실패'.
 * 스트림의 `error` 이벤트가 하나라도 오면 실패다 — 저장은 실행기가 이미 했다
 */
export async function executeSchedule(row: AppScheduleRow, io: ExecuteIo = defaultExecuteIo()): Promise<ScheduleOutcome> {
  const user = await io.loadUser(row.user_id);
  if (!user || user.is_active === false || user.deleted_at) return { kind: 'pause', reason: PAUSED_USER_UNAVAILABLE };
  if (!user.department_id || user.department_id !== row.department_id) return { kind: 'pause', reason: PAUSED_DEPARTMENT_CHANGED };
  const session = {
    user: { id: user.id, email: user.email ?? undefined, role: user.role === 'ADMIN' ? 'ADMIN' : 'USER', departmentId: user.department_id },
    expires: new Date(Date.now() + 5 * 60_000).toISOString(),
  } as Session;
  const prepared = await io.prepare(session, { agent_id: row.agent_id, message: '앱 실행', app_inputs: row.inputs, app_version: row.app_version });
  if (!prepared.ok) {
    if (prepared.status === 409) return { kind: 'pause', reason: PAUSED_APP_CHANGED };
    if (prepared.status === 403 || prepared.status === 404) return { kind: 'pause', reason: PAUSED_APP_UNAVAILABLE };
    return { kind: 'failed', error: prepared.message };
  }
  let conversationId: string | null = null; let error: string | null = null; let done = false;
  try {
    await io.stream(prepared.turn, (event) => {
      if (event.event === 'meta') conversationId = event.data.conversation_id;
      else if (event.event === 'error') error = error ?? event.data.message;
      else if (event.event === 'done') done = true;
    });
  } catch (failure) { error = error ?? errorText(failure); }
  if (error) return { kind: 'failed', error, conversationId };
  if (!done) return { kind: 'failed', error: '응답이 끝나지 않았습니다.', conversationId };
  if (conversationId) {
    try { await io.retitle(conversationId); } catch { /* 제목은 표시일 뿐 — 실행 결과를 바꾸지 않는다 */ }
  }
  return { kind: 'completed', conversationId };
}

export function defaultExecuteIo(): ExecuteIo {
  return {
    async loadUser(userId) {
      const { data, error } = await supabaseAdmin.from('users').select('id, email, role, department_id, is_active, deleted_at').eq('id', userId).maybeSingle();
      if (error) throw new Error(`users: ${error.message}`);
      return (data as ScheduleUser | null) ?? null;
    },
    prepare: prepareTurn,
    stream: (turn, send) => streamTurn(turn, send),
    async retitle(conversationId) {
      const { data } = await supabaseAdmin.from('conversations').select('title').eq('id', conversationId).maybeSingle();
      const title: string = data?.title ?? '';
      if (title.startsWith(SCHEDULE_TITLE_PREFIX)) return;
      await supabaseAdmin.from('conversations').update({ title: `${SCHEDULE_TITLE_PREFIX}${title || '앱 실행'}`.slice(0, 200) }).eq('id', conversationId);
    },
  };
}

export function scheduleDeps(): ScheduleDeps {
  return {
    async due(nowMs, limit) {
      const now = new Date(nowMs).toISOString();
      const stale = new Date(nowMs - SCHEDULE_CLAIM_STALE_MS).toISOString();
      const { data, error } = await supabaseAdmin.from('app_schedules').select('*')
        .eq('status', 'active').lte('next_run_at', now).or(`claimed_at.is.null,claimed_at.lt.${stale}`)
        .order('next_run_at', { ascending: true }).limit(limit);
      if (error) throw new Error(`app_schedules: ${error.message}`);
      return (data ?? []) as AppScheduleRow[];
    },
    async claim(id, nowMs) {
      const now = new Date(nowMs).toISOString();
      const stale = new Date(nowMs - SCHEDULE_CLAIM_STALE_MS).toISOString();
      const { data, error } = await supabaseAdmin.from('app_schedules').update({ claimed_at: now, updated_at: now })
        .eq('id', id).eq('status', 'active').lte('next_run_at', now).or(`claimed_at.is.null,claimed_at.lt.${stale}`).select('id');
      if (error) throw new Error(`app_schedules claim: ${error.message}`);
      return (data ?? []).length === 1;
    },
    execute: (row) => executeSchedule(row),
    async finish(id, patch) {
      const { error } = await supabaseAdmin.from('app_schedules').update(patch).eq('id', id);
      if (error) throw new Error(`app_schedules finish: ${error.message}`);
    },
    async notifyFailure(row, info) {
      if (!isMailConfigured()) return;
      const [{ data: user }, { data: agent }] = await Promise.all([
        supabaseAdmin.from('users').select('email').eq('id', row.user_id).maybeSingle(),
        supabaseAdmin.from('agents').select('name').eq('id', row.agent_id).maybeSingle(),
      ]);
      const to = typeof user?.email === 'string' ? user.email.trim() : '';
      if (!to) return;
      const mail = scheduleFailureMail({
        appName: agent?.name ?? '입력형 앱', description: describeSchedule(specOfRow(row)), error: info.error, paused: info.paused,
        nextRunAt: info.nextRunAt, schedulesUrl: `${APP_URL}/apps/schedules`, failedAt: new Date(),
      });
      const sent = await sendScheduleFailureEmail(to, mail);
      if (!sent.sent) throw new Error(sent.error ?? sent.reason ?? 'send_failed');
    },
    log: (level, message, details, organizationId) => logSystem({ level, category: 'api', message, details, orgId: organizationId }),
    now: () => Date.now(),
  };
}
