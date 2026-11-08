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
// - 올린 파일은 예약할 수 없다(첨부는 한 대화에 묶이고 서명 주소가 짧다). 문서함에서 고른 문서(0062)는 id로 저장하고 실행 때마다 다시 읽으며,
//   새 판이 근거가 되면 새 판을 쓴다(`currentEditionIds`). 쓸 판이 없으면 예약을 멈춘다. 실행기는 `/api/cron/app-schedules`(CRON_SECRET)이고 pg_cron이 5분마다 부른다.
//   Vercel Hobby 예약 작업은 하루 한 번·2개까지라 쓰지 않는다 — docs/benchmarks/allganize/APP_SCHEDULES.md.
import { supabaseAdmin } from '@/lib/supabaseAdmin';
import { APP_URL } from '@/lib/config';
import { logSystem } from '@/lib/logger';
import { isMailConfigured, scheduleFailureMail, scheduleSuccessMail, sendScheduleFailureEmail, sendScheduleSuccessEmail } from '@/lib/mailer';
import { defaultRunAsIo, runAppAs, type RunAsIo } from './run-as';
import { SCHEDULE_CLAIM_STALE_MS, describeSchedule, nextRunAt, specOfRow, type AppScheduleRowLike } from './schedule-spec';
import { currentEditionIds, type LibraryDocumentRow } from './library-documents';
import { agentDocumentRows } from './app-document-choice';

export const SCHEDULE_MAX_CONSECUTIVE_FAILURES = 3;
export { SCHEDULE_CLAIM_STALE_MS } from './schedule-spec';
/** 한 번 불릴 때 쓰는 시간 예산 — 라우트 `maxDuration` 300초 안에서 실행 하나(단계 3개 + 최종, 최대 수 분)가 끝날 여유를 둔다 */
export const SCHEDULE_RUN_BUDGET_MS = 180_000;
export const SCHEDULE_BATCH = 3;
/**
 * 한 번 불린 실행기 안에서 앱 실행이 **새 모델 호출을 시작하지 않을** 마감(시작 + 이 값, 2026-11-07) — 셋째 예약이 179초에 시작해도
 * 진행 중이던 호출과 마지막 단계·저장이 300초 안에 끝나게. 넘으면 그 실행은 '시간이 길어 멈춤' 실패로 기록된다
 */
export const SCHEDULE_TURN_DEADLINE_MS = 200_000;
export const PAUSED_AFTER_FAILURES = `연속 ${SCHEDULE_MAX_CONSECUTIVE_FAILURES}회 실패해 예약을 멈췄습니다. 입력과 앱 설정을 확인한 뒤 다시 켜 주세요.`;
export const PAUSED_APP_CHANGED = `앱 설정이 바뀌어 예약을 멈췄습니다. 앱 예약 목록에서 '고치기'로 입력을 확인해 저장하면 다시 켜집니다.`;
export const PAUSED_APP_UNAVAILABLE = '앱을 쓸 수 없어(권한 없음 또는 삭제됨) 예약을 멈췄습니다.';
export const PAUSED_USER_UNAVAILABLE = '예약한 직원의 계정을 쓸 수 없어 예약을 멈췄습니다.';
export const PAUSED_DEPARTMENT_CHANGED = `소속 부서가 바뀌어 예약을 멈췄습니다. 앱 예약 목록에서 '고치기'로 저장하면 지금 부서로 다시 켜집니다.`;
export const PAUSED_DOCUMENTS_UNAVAILABLE = `고른 문서를 더 쓸 수 없어(지움·읽기 실패·지난 판) 예약을 멈췄습니다. 앱 예약 목록에서 '고치기'로 문서를 다시 골라 저장해 주세요.`;
export const SCHEDULE_TITLE_PREFIX = '[예약] ';

export type AppScheduleRow = AppScheduleRowLike & {
  user_id: string; department_id: string; organization_id: string; claimed_at: string | null; updated_at: string;
};

export type ScheduleOutcome =
  | { kind: 'completed'; conversationId: string | null; /** 새 판으로 따라간 문서 — 다음 실행부터 이 id로 */ documentIds?: string[] }
  | { kind: 'failed'; error: string; conversationId?: string | null }
  | { kind: 'pause'; reason: string };

export type SchedulePatch = Partial<Pick<AppScheduleRow,
  'status' | 'paused_reason' | 'next_run_at' | 'claimed_at' | 'last_run_at' | 'last_status' | 'last_error' | 'last_conversation_id' | 'consecutive_failures' | 'run_count' | 'updated_at' | 'document_ids'>>;

export interface ScheduleDeps {
  /** 지금 실행할 차례인 활성 예약(차지되지 않았거나 멈춘 차지) — 다음 실행 시각 순 */
  due(nowMs: number, limit: number): Promise<AppScheduleRow[]>;
  /** 조건부로 차지했으면 true. 다른 실행기가 먼저 잡았으면 false */
  claim(id: string, nowMs: number): Promise<boolean>;
  /** `deadlineAt` = 이 실행기 호출 전체의 마감(새 모델 호출을 시작하지 않을 시각) */
  execute(row: AppScheduleRow, deadlineAt: number): Promise<ScheduleOutcome>;
  finish(id: string, patch: SchedulePatch): Promise<void>;
  notifyFailure(row: AppScheduleRow, info: { error: string; paused: boolean; nextRunAt: string | null }): Promise<void>;
  /** 실행을 마쳤을 때 — 직원이 '완료 메일'을 고른 예약만(0069). 결과 글은 싣지 않고 결과 보기 링크만 */
  notifySuccess(row: AppScheduleRow, info: { conversationId: string | null; nextRunAt: string | null }): Promise<void>;
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
    return { ...base, last_status: 'completed', last_error: null, last_conversation_id: outcome.conversationId ?? null, consecutive_failures: 0, ...(outcome.documentIds ? { document_ids: outcome.documentIds } : {}) };
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
    try { outcome = await deps.execute(row, started + SCHEDULE_TURN_DEADLINE_MS); }
    catch (error) { outcome = { kind: 'failed', error: errorText(error) }; }

    const patch = finishPatch(row, outcome, deps.now());
    try { await deps.finish(row.id, patch); }
    catch (error) {
      // 차지가 남아 15분 뒤 다시 잡힌다 — 끝난 실행이 한 번 더 돌 수 있어 기록을 남긴다
      await deps.log('error', '앱 예약 실행 결과를 저장하지 못함', { schedule_id: row.id, outcome: outcome.kind, error: errorText(error) }, row.organization_id);
    }

    if (outcome.kind === 'completed') {
      result.completed++;
      if (row.notify_on_success === true) {
        try { await deps.notifySuccess(row, { conversationId: outcome.conversationId ?? null, nextRunAt: patch.next_run_at ?? null }); }
        catch (notifyError) { await deps.log('warning', '앱 예약 완료 알림을 보내지 못함', { schedule_id: row.id, error: errorText(notifyError) }, row.organization_id); }
      }
      continue;
    }
    const paused = patch.status === 'paused';
    if (paused) result.paused++; else result.failed++;
    const error = outcome.kind === 'pause' ? outcome.reason : outcome.error;
    await deps.log('warning', paused ? '앱 예약을 멈춤' : '앱 예약 실행 실패', { schedule_id: row.id, agent_id: row.agent_id, reason: error.slice(0, 200), paused }, row.organization_id);
    try { await deps.notifyFailure(row, { error, paused, nextRunAt: patch.next_run_at ?? null }); }
    catch (notifyError) { await deps.log('warning', '앱 예약 실패 알림을 보내지 못함', { schedule_id: row.id, error: errorText(notifyError) }, row.organization_id); }
  }
  return result;
}

/** 예약 실행의 바깥 입출력 — 공용 `runAppAs`와 같고, 고른 문서가 있으면 그 비서의 문서 행을 읽는다(시험이 바꿔 끼운다) */
export type ExecuteIo = RunAsIo & { documentsOf?(agentId: string, organizationId: string): Promise<LibraryDocumentRow[]> };


/**
 * 예약 하나를 그 직원으로 실행한다(`run-as.ts`). 거절 상태 403·404(앱을 쓸 수 없음)·409(앱 판 바뀜)와 계정·부서 문제는 '멈춤',
 * 그 밖(한도 429·검사 400·모델 오류)은 '실패'. 스트림의 `error` 이벤트가 하나라도 오면 실패다 — 저장은 실행기가 이미 했다
 */
export async function executeSchedule(row: AppScheduleRow, io: ExecuteIo = defaultRunAsIo(), deadlineAt?: number): Promise<ScheduleOutcome> {
  // 고른 문서(0062) — 지금 근거로 쓸 판으로 맞춘다. 문서 행을 못 읽으면 던져 '실패'(다음 차례에 다시)
  let documentIds: string[] | undefined;
  let followed = false;
  if (row.document_ids?.length) {
    const rows = await (io.documentsOf ?? agentDocumentRows)(row.agent_id, row.organization_id);
    const resolved = currentEditionIds(row.document_ids, rows, row.agent_id);
    if (!resolved.ok) return { kind: 'pause', reason: PAUSED_DOCUMENTS_UNAVAILABLE };
    documentIds = resolved.ids;
    followed = resolved.changed;
  }
  const outcome = await runAppAs({ userId: row.user_id, departmentId: row.department_id, agentId: row.agent_id, appVersion: row.app_version, inputs: row.inputs, documentIds, ...(deadlineAt !== undefined ? { deadlineAt } : {}) }, SCHEDULE_TITLE_PREFIX, io);
  switch (outcome.kind) {
    case 'completed': return { kind: 'completed', conversationId: outcome.conversationId, ...(followed ? { documentIds } : {}) };
    case 'user_unavailable': return { kind: 'pause', reason: PAUSED_USER_UNAVAILABLE };
    case 'department_changed': return { kind: 'pause', reason: PAUSED_DEPARTMENT_CHANGED };
    case 'rejected':
      if (outcome.status === 409) return { kind: 'pause', reason: PAUSED_APP_CHANGED };
      if (outcome.status === 403 || outcome.status === 404) return { kind: 'pause', reason: PAUSED_APP_UNAVAILABLE };
      return { kind: 'failed', error: outcome.message };
    case 'failed': return { kind: 'failed', error: outcome.error, conversationId: outcome.conversationId };
  }
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
    execute: (row, deadlineAt) => executeSchedule(row, undefined, deadlineAt),
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
    async notifySuccess(row, info) {
      if (!isMailConfigured()) return;
      const [{ data: user }, { data: agent }] = await Promise.all([
        supabaseAdmin.from('users').select('email').eq('id', row.user_id).maybeSingle(),
        supabaseAdmin.from('agents').select('name').eq('id', row.agent_id).maybeSingle(),
      ]);
      const to = typeof user?.email === 'string' ? user.email.trim() : '';
      if (!to) return;
      const mail = scheduleSuccessMail({
        appName: agent?.name ?? '입력형 앱', description: describeSchedule(specOfRow(row)), nextRunAt: info.nextRunAt, finishedAt: new Date(),
        resultUrl: info.conversationId ? `${APP_URL}/chat?conv=${encodeURIComponent(info.conversationId)}` : `${APP_URL}/apps/history?agent=${encodeURIComponent(row.agent_id)}`,
        schedulesUrl: `${APP_URL}/apps/schedules`,
      });
      const sent = await sendScheduleSuccessEmail(to, mail);
      if (!sent.sent) throw new Error(sent.error ?? sent.reason ?? 'send_failed');
    },
    log: (level, message, details, organizationId) => logSystem({ level, category: 'api', message, details, orgId: organizationId }),
    now: () => Date.now(),
  };
}
