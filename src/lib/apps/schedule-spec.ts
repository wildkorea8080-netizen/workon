// src/lib/apps/schedule-spec.ts
// 입력형 앱 예약의 '언제'(순수 함수 — 화면과 서버가 함께 쓴다. 아무것도 import하지 않는다).
// 시각은 모두 한국 시간(KST, UTC+9) 기준이고 직원이 시간대를 고르지는 않는다 — 공공기관 직원은 한국에서 일한다.

export type AppScheduleFrequency = 'daily' | 'weekdays' | 'weekly' | 'monthly';
export type AppScheduleSpec = {
  frequency: AppScheduleFrequency;
  /** weekly일 때 0(일)~6(토) */
  weekday: number | null;
  /** monthly일 때 1~28 — 모든 달에 있는 날만(29~31은 건너뛰는 달이 생긴다) */
  monthDay: number | null;
  hour: number;
  minute: 0 | 30;
};

/** 한 사람이 둘 수 있는 예약 수(멈춘 것 포함). 예약마다 실행마다 모델을 부르므로 상한을 둔다 */
export const APP_MAX_SCHEDULES_PER_USER = 5;
/** 활성 예약의 다음 실행 시각이 이만큼 지났는데 실행되지 않았으면 화면에 '지연'을 보인다(실행기가 안 도는 신호) */
export const SCHEDULE_OVERDUE_MS = 60 * 60 * 1000;
export const KST_OFFSET_MS = 9 * 60 * 60 * 1000;
export const WEEKDAY_LABELS = ['일', '월', '화', '수', '목', '금', '토'] as const;
export const FREQUENCY_LABELS: Record<AppScheduleFrequency, string> = { daily: '매일', weekdays: '평일(월~금)', weekly: '매주', monthly: '매월' };

const FREQUENCIES: AppScheduleFrequency[] = ['daily', 'weekdays', 'weekly', 'monthly'];

function integer(raw: unknown): number | null {
  const n = typeof raw === 'string' && raw.trim() ? Number(raw) : raw;
  return typeof n === 'number' && Number.isInteger(n) ? n : null;
}

/** 요청 본문·DB 행(frequency·weekday·month_day·hour·minute)을 예약 규칙으로. 틀리면 한국어 이유 */
export function parseScheduleSpec(raw: unknown): { ok: true; value: AppScheduleSpec } | { ok: false; message: string } {
  if (!raw || typeof raw !== 'object') return { ok: false, message: '예약 주기를 확인해 주세요.' };
  const r = raw as Record<string, unknown>;
  const frequency = r.frequency;
  if (typeof frequency !== 'string' || !FREQUENCIES.includes(frequency as AppScheduleFrequency)) return { ok: false, message: '예약 주기는 매일·평일·매주·매월 중 하나입니다.' };
  const hour = integer(r.hour); const minute = integer(r.minute);
  if (hour === null || hour < 0 || hour > 23) return { ok: false, message: '실행 시각(시)은 0~23 사이입니다.' };
  if (minute !== 0 && minute !== 30) return { ok: false, message: '실행 시각(분)은 0 또는 30입니다.' };
  let weekday: number | null = null; let monthDay: number | null = null;
  if (frequency === 'weekly') {
    weekday = integer(r.weekday);
    if (weekday === null || weekday < 0 || weekday > 6) return { ok: false, message: '매주 실행할 요일을 골라 주세요.' };
  }
  if (frequency === 'monthly') {
    monthDay = integer(r.month_day ?? r.monthDay);
    if (monthDay === null || monthDay < 1 || monthDay > 28) return { ok: false, message: '매월 실행할 날은 1~28일 중 하나입니다(모든 달에 있는 날만).' };
  }
  return { ok: true, value: { frequency: frequency as AppScheduleFrequency, weekday, monthDay, hour, minute } };
}

function matchesDay(spec: AppScheduleSpec, kstDay: Date): boolean {
  const dow = kstDay.getUTCDay();
  switch (spec.frequency) {
    case 'daily': return true;
    case 'weekdays': return dow >= 1 && dow <= 5;
    case 'weekly': return dow === spec.weekday;
    case 'monthly': return kstDay.getUTCDate() === spec.monthDay;
  }
}

/**
 * `afterMs`(UTC 밀리초) **뒤** 첫 실행 시각. 그 시각이 정확히 실행 시각이면 다음 차례다(같은 시각에 두 번 돌지 않게).
 * KST 날짜 성분으로 셈한다 — Date에 KST 오프셋을 더한 뒤 UTC 성분을 읽는 방식(한국은 서머타임이 없다)
 */
export function nextRunAt(spec: AppScheduleSpec, afterMs: number): Date {
  const kst = new Date(afterMs + KST_OFFSET_MS);
  let day = Date.UTC(kst.getUTCFullYear(), kst.getUTCMonth(), kst.getUTCDate());
  for (let i = 0; i < 70; i++) {
    const at = day + spec.hour * 3_600_000 + spec.minute * 60_000 - KST_OFFSET_MS;
    if (at > afterMs && matchesDay(spec, new Date(day))) return new Date(at);
    day += 24 * 3_600_000;
  }
  throw new Error('다음 실행 시각을 구하지 못했습니다.');
}

export function describeSchedule(spec: AppScheduleSpec): string {
  const time = `${String(spec.hour).padStart(2, '0')}:${String(spec.minute).padStart(2, '0')}`;
  switch (spec.frequency) {
    case 'daily': return `매일 ${time}`;
    case 'weekdays': return `평일 ${time}`;
    case 'weekly': return `매주 ${WEEKDAY_LABELS[spec.weekday ?? 0]}요일 ${time}`;
    case 'monthly': return `매월 ${spec.monthDay}일 ${time}`;
  }
}

/** DB 행 중 화면이 보는 칸. 실행 조건·사용자 id·부서는 내보내지 않는다 */
export type AppScheduleRowLike = {
  id: string; agent_id: string; app_version: number; inputs: Record<string, string>;
  frequency: string; weekday: number | null; month_day: number | null; run_hour: number; run_minute: number;
  status: string; paused_reason: string | null; next_run_at: string; last_run_at: string | null;
  last_status: string | null; last_error: string | null; last_conversation_id: string | null;
  consecutive_failures: number; run_count: number; created_at: string;
};

export type AppScheduleView = {
  id: string; agentId: string; appName: string; appVersion: number; inputs: Record<string, string>;
  spec: AppScheduleSpec; description: string; status: 'active' | 'paused'; pausedReason: string | null;
  nextRunAt: string; lastRunAt: string | null; lastStatus: 'completed' | 'failed' | null; lastError: string | null;
  lastConversationId: string | null; consecutiveFailures: number; runCount: number; overdue: boolean; createdAt: string;
};

export function specOfRow(row: Pick<AppScheduleRowLike, 'frequency' | 'weekday' | 'month_day' | 'run_hour' | 'run_minute'>): AppScheduleSpec {
  const parsed = parseScheduleSpec({ frequency: row.frequency, weekday: row.weekday, month_day: row.month_day, hour: row.run_hour, minute: row.run_minute });
  if (!parsed.ok) throw new Error(`예약 행이 깨졌습니다: ${parsed.message}`);
  return parsed.value;
}

export function scheduleView(row: AppScheduleRowLike, appName: string | null, nowMs: number): AppScheduleView {
  const spec = specOfRow(row);
  const status = row.status === 'paused' ? 'paused' : 'active';
  return {
    id: row.id, agentId: row.agent_id, appName: appName ?? '삭제된 앱', appVersion: row.app_version, inputs: row.inputs ?? {},
    spec, description: describeSchedule(spec), status, pausedReason: row.paused_reason,
    nextRunAt: row.next_run_at, lastRunAt: row.last_run_at,
    lastStatus: row.last_status === 'completed' || row.last_status === 'failed' ? row.last_status : null,
    lastError: row.last_error, lastConversationId: row.last_conversation_id,
    consecutiveFailures: row.consecutive_failures, runCount: row.run_count,
    overdue: status === 'active' && Date.parse(row.next_run_at) < nowMs - SCHEDULE_OVERDUE_MS,
    createdAt: row.created_at,
  };
}
