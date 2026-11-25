// src/lib/apps/schedule-spec.ts
// 입력형 앱 예약의 '언제'(순수 함수 — 화면과 서버가 함께 쓴다. 아무것도 import하지 않는다).
// 시각은 예약마다 고른 시간대의 벽시계 기준이다(2026-11-25, 0119 — 기본 한국 시간, 해외 사무소용으로 정해 둔 도시 시간대만).
// 서머타임이 있는 시간대는 Intl(IANA 시간대 자료)로 그날의 오프셋을 다시 본다.

export type AppScheduleFrequency = 'daily' | 'weekdays' | 'weekly' | 'monthly';
export type AppScheduleSpec = {
  frequency: AppScheduleFrequency;
  /** weekly일 때 0(일)~6(토) */
  weekday: number | null;
  /** monthly일 때 1~28 — 모든 달에 있는 날만(29~31은 건너뛰는 달이 생긴다) */
  monthDay: number | null;
  hour: number;
  /** 0~55, 5분 단위(실행기가 5분마다 돈다 — 2026-11-25 전에는 00·30분만) */
  minute: number;
  /** (0119) IANA 시간대 — 자주 쓰는 목록(`SCHEDULE_TIME_ZONES`)이나 이 실행 환경이 아는 IANA 이름(`isScheduleTimeZone`). 기본 'Asia/Seoul' */
  timeZone: ScheduleTimeZone;
};

/**
 * (0119) 고를 수 있는 시간대 — 해외 사무소·주재관이 흔한 도시. 목록 밖은 받지 않는다(저장 값은 IANA 이름이라 목록을 늘리면 마이그레이션 없이 된다)
 */
export const SCHEDULE_TIME_ZONES = {
  'Asia/Seoul': '한국',
  'Asia/Tokyo': '일본(도쿄)',
  'Asia/Shanghai': '중국(베이징)',
  'Asia/Taipei': '대만(타이베이)',
  'Asia/Ho_Chi_Minh': '베트남(호찌민)',
  'Asia/Bangkok': '태국(방콕)',
  'Asia/Singapore': '싱가포르',
  'Asia/Jakarta': '인도네시아(자카르타)',
  'Asia/Kolkata': '인도(뉴델리)',
  'Asia/Dubai': '아랍에미리트(두바이)',
  'Europe/London': '영국(런던)',
  'Europe/Paris': '프랑스(파리)',
  'Europe/Berlin': '독일(베를린)',
  'America/New_York': '미국 동부(뉴욕·워싱턴)',
  'America/Chicago': '미국 중부(시카고)',
  'America/Los_Angeles': '미국 서부(로스앤젤레스)',
  'Australia/Sydney': '호주(시드니)',
  UTC: '협정 세계시(UTC)',
} as const satisfies Record<string, string>;
/** IANA 시간대 이름 — 값 검사는 `isScheduleTimeZone` */
export type ScheduleTimeZone = string;
export const DEFAULT_SCHEDULE_TIME_ZONE: ScheduleTimeZone = 'Asia/Seoul';
/** 예약에 고를 수 있는 분(5분 단위) */
export const SCHEDULE_MINUTES: readonly number[] = Array.from({ length: 12 }, (_, i) => i * 5);
/** DB CHECK(0119)와 같은 꼴 — 영문으로 시작, 영문·숫자·`_`·`+`·`-`, `/`로 세 조각까지, 64자 */
const TIME_ZONE_SHAPE = /^[A-Za-z][A-Za-z0-9_+-]*(\/[A-Za-z0-9_+-]+){0,2}$/;
const knownZones = new Map<string, boolean>();

function listedZone(raw: string): raw is keyof typeof SCHEDULE_TIME_ZONES {
  return Object.prototype.hasOwnProperty.call(SCHEDULE_TIME_ZONES, raw);
}

/**
 * 고를 수 있는 시간대인가 — 자주 쓰는 목록, 또는 이 실행 환경의 IANA 자료(`Intl`)가 아는 **정식 이름**(대소문자·별칭이 다르면 아님)이고 DB 꼴에 맞는 것
 */
export function isScheduleTimeZone(raw: unknown): raw is ScheduleTimeZone {
  if (typeof raw !== 'string') return false;
  if (listedZone(raw)) return true;
  if (raw.length > 64 || !TIME_ZONE_SHAPE.test(raw)) return false;
  const known = knownZones.get(raw);
  if (known !== undefined) return known;
  let ok = false;
  try { ok = new Intl.DateTimeFormat('en-US', { timeZone: raw }).resolvedOptions().timeZone === raw; } catch { ok = false; }
  knownZones.set(raw, ok);
  return ok;
}

/** 그 시간대의 시간 이름 — '한국 시간'·'미국 동부(뉴욕·워싱턴) 시간', 목록 밖이면 'Europe/Madrid 시간' */
export function timeZoneLabel(tz: ScheduleTimeZone): string {
  if (tz === 'UTC') return SCHEDULE_TIME_ZONES.UTC;
  return listedZone(tz) ? `${SCHEDULE_TIME_ZONES[tz]} 시간` : `${tz} 시간`;
}

/** 목록 밖에서 고를 수 있는 시간대(화면의 '그 밖의 시간대') — 이 실행 환경이 아는 것 중 목록에 없고 DB 꼴에 맞는 것, 이름 순 */
export function otherScheduleTimeZones(): string[] {
  const supported = (Intl as unknown as { supportedValuesOf?: (key: string) => string[] }).supportedValuesOf;
  if (typeof supported !== 'function') return [];
  try {
    return supported('timeZone').filter((tz) => !listedZone(tz) && isScheduleTimeZone(tz)).sort();
  } catch {
    return [];
  }
}

/** 차지(실행 중 표시)가 이보다 오래되면 실행기가 죽은 것으로 보고 다시 잡는다 */
export const SCHEDULE_CLAIM_STALE_MS = 15 * 60 * 1000;
/** 한 사람이 둘 수 있는 예약 수(멈춘 것 포함). 예약마다 실행마다 모델을 부르므로 상한을 둔다 */
export const APP_MAX_SCHEDULES_PER_USER = 5;
/** 활성 예약의 다음 실행 시각이 이만큼 지났는데 실행되지 않았으면 화면에 '지연'을 보인다(실행기가 안 도는 신호) */
export const SCHEDULE_OVERDUE_MS = 60 * 60 * 1000;
export const KST_OFFSET_MS = 9 * 60 * 60 * 1000;
/** 직원이 멈춘 예약의 이유 글(라우트 파일은 핸들러·설정 외에는 내보낼 수 없어 여기 둔다) */
export const PAUSED_BY_USER = '직원이 멈췄습니다.';
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
  if (minute === null || minute < 0 || minute > 55 || minute % 5 !== 0) return { ok: false, message: '실행 시각(분)은 0~55 사이 5분 단위입니다.' };
  let weekday: number | null = null; let monthDay: number | null = null;
  if (frequency === 'weekly') {
    weekday = integer(r.weekday);
    if (weekday === null || weekday < 0 || weekday > 6) return { ok: false, message: '매주 실행할 요일을 골라 주세요.' };
  }
  if (frequency === 'monthly') {
    monthDay = integer(r.month_day ?? r.monthDay);
    if (monthDay === null || monthDay < 1 || monthDay > 28) return { ok: false, message: '매월 실행할 날은 1~28일 중 하나입니다(모든 달에 있는 날만).' };
  }
  // 시간대(0119) — 없으면(옛 화면·옛 행) 한국 시간
  const tzRaw = r.time_zone ?? r.timeZone;
  const timeZone = tzRaw === undefined || tzRaw === null || tzRaw === '' ? DEFAULT_SCHEDULE_TIME_ZONE : tzRaw;
  if (!isScheduleTimeZone(timeZone)) return { ok: false, message: '시간대를 확인해 주세요(목록에 있는 시간대나 IANA 시간대 이름만).' };
  return { ok: true, value: { frequency: frequency as AppScheduleFrequency, weekday, monthDay, hour, minute, timeZone } };
}

function matchesDay(spec: AppScheduleSpec, localDay: Date): boolean {
  const dow = localDay.getUTCDay();
  switch (spec.frequency) {
    case 'daily': return true;
    case 'weekdays': return dow >= 1 && dow <= 5;
    case 'weekly': return dow === spec.weekday;
    case 'monthly': return localDay.getUTCDate() === spec.monthDay;
  }
}

const formatters = new Map<string, Intl.DateTimeFormat>();
/** 그 시간대에서 `ms`의 벽시계 성분(연·월·일·시·분) — 서머타임까지 IANA 자료로 */
function wallParts(tz: ScheduleTimeZone, ms: number): { y: number; m: number; d: number; h: number; min: number } {
  let f = formatters.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric' });
    formatters.set(tz, f);
  }
  const p: Record<string, number> = {};
  for (const part of f.formatToParts(new Date(ms))) if (part.type !== 'literal') p[part.type] = Number(part.value);
  return { y: p.year, m: p.month, d: p.day, h: p.hour === 24 ? 0 : p.hour, min: p.minute };
}

/** 그 시간대의 UTC와의 차(밀리초, 분 단위까지) — `ms` 때 */
export function zoneOffsetMs(tz: ScheduleTimeZone, ms: number): number {
  if (tz === 'Asia/Seoul') return KST_OFFSET_MS;
  const w = wallParts(tz, ms);
  return Date.UTC(w.y, w.m - 1, w.d, w.h, w.min) - Math.floor(ms / 60_000) * 60_000;
}

/**
 * 그 시간대의 벽시계 시각(`wallMs` — 날짜·시각을 UTC 성분으로 적은 값) → 실제 UTC 밀리초.
 * 서머타임으로 그 시각이 두 번 오면(가을) 앞의 것, 없으면(봄에 건너뜀) 건너뛰기 전 오프셋으로 — 한 시간 뒤의 같은 실제 시각에 돈다
 */
export function wallToUtc(tz: ScheduleTimeZone, wallMs: number): number {
  const before = zoneOffsetMs(tz, wallMs - 14 * 3_600_000);
  const after = zoneOffsetMs(tz, wallMs + 14 * 3_600_000);
  const valid = Array.from(new Set([before, after])).map((o) => wallMs - o).filter((c) => zoneOffsetMs(tz, c) === wallMs - c);
  return valid.length ? Math.min(...valid) : wallMs - before;
}

/**
 * `afterMs`(UTC 밀리초) **뒤** 첫 실행 시각. 그 시각이 정확히 실행 시각이면 다음 차례다(같은 시각에 두 번 돌지 않게).
 * 고른 시간대의 날짜 성분으로 셈한다 — 날마다 그날의 오프셋으로 바꾼다(서머타임 — `wallToUtc`). 한국 시간은 예전 셈 그대로
 */
export function nextRunAt(spec: AppScheduleSpec, afterMs: number): Date {
  const tz = spec.timeZone ?? DEFAULT_SCHEDULE_TIME_ZONE;
  const w = wallParts(tz, afterMs);
  // 그 시간대의 어제부터 본다 — 오프셋이 바뀌는 날에도 놓치지 않게(`at > afterMs`가 거른다)
  let day = Date.UTC(w.y, w.m - 1, w.d) - 24 * 3_600_000;
  for (let i = 0; i < 72; i++) {
    const wall = day + spec.hour * 3_600_000 + spec.minute * 60_000;
    const at = tz === 'Asia/Seoul' ? wall - KST_OFFSET_MS : wallToUtc(tz, wall);
    if (at > afterMs && matchesDay(spec, new Date(day))) return new Date(at);
    day += 24 * 3_600_000;
  }
  throw new Error('다음 실행 시각을 구하지 못했습니다.');
}

export function describeSchedule(spec: AppScheduleSpec): string {
  const time = `${String(spec.hour).padStart(2, '0')}:${String(spec.minute).padStart(2, '0')}`;
  const zone = spec.timeZone && spec.timeZone !== DEFAULT_SCHEDULE_TIME_ZONE ? ` (${timeZoneLabel(spec.timeZone)})` : '';
  switch (spec.frequency) {
    case 'daily': return `매일 ${time}${zone}`;
    case 'weekdays': return `평일 ${time}${zone}`;
    case 'weekly': return `매주 ${WEEKDAY_LABELS[spec.weekday ?? 0]}요일 ${time}${zone}`;
    case 'monthly': return `매월 ${spec.monthDay}일 ${time}${zone}`;
  }
}

/** (0119) 그 시간대 벽시계로 'M월 D일 HH:MM' — 한국 시간이 아닌 예약의 다음 실행을 현지 시각으로도 보인다 */
export function formatInZone(iso: string, tz: ScheduleTimeZone): string {
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) return '—';
  const w = wallParts(tz, ms);
  return `${w.m}월 ${w.d}일 ${String(w.h).padStart(2, '0')}:${String(w.min).padStart(2, '0')}`;
}

/** 예약 규칙 → DB 칸(만들기·고치기가 함께 쓴다) */
export function specColumns(spec: AppScheduleSpec) {
  return { frequency: spec.frequency, weekday: spec.weekday, month_day: spec.monthDay, run_hour: spec.hour, run_minute: spec.minute, time_zone: spec.timeZone ?? DEFAULT_SCHEDULE_TIME_ZONE };
}

/** 기관 전체 관리자가 예약 실행을 꺼 두었을 때(0070) — 직원 목록 안내와 새 예약 거절 */
export const SCHEDULE_ORG_DISABLED = '기관 관리자가 앱 예약 실행을 꺼 두었습니다. 다시 켤 때까지 예약이 실행되지 않고 다음 차례로 넘어갑니다.';
/** 기관이 정지·종료돼 넘길 때(2026-11-19) — 스위치 문구('관리자가 꺼 두었습니다')와 가른다 */
export const SCHEDULE_ORG_STOPPED = '기관 이용이 정지되었거나 종료되어 예약이 실행되지 않고 다음 차례로 넘어갑니다.';
export const SCHEDULE_ORG_DISABLED_CREATE = '기관 관리자가 앱 예약 실행을 꺼 두어 새 예약을 만들 수 없습니다.';

/** 실행기가 차지한 동안(실행 중)에는 고치지 않는다 — 끝난 실행이 고친 시각·입력을 옛 값으로 덮는다 */
export const SCHEDULE_BUSY_MESSAGE = '지금 실행 중인 예약입니다. 몇 분 뒤 실행이 끝나면 다시 고쳐 주세요.';

/**
 * 고친 뒤의 상태 — 직원이 멈춘 예약은 멈춘 채로 고친다(다시 켜기는 따로). 실행기가 멈춘 예약(앱 설정 바뀜·문서 못 씀·부서 바뀜·연속 실패)은
 * 고친 것이 곧 해결이므로 다시 켜고 실패 수를 지운다. 관리자가 멈춘 예약(0050)은 라우트가 고치기 전에 막는다
 */
export function editedStatus(row: Pick<AppScheduleRowLike, 'status' | 'paused_reason' | 'consecutive_failures'>): { status: 'active' | 'paused'; paused_reason: string | null; consecutive_failures: number } {
  if (row.status === 'paused' && row.paused_reason === PAUSED_BY_USER) return { status: 'paused', paused_reason: PAUSED_BY_USER, consecutive_failures: row.consecutive_failures };
  return { status: 'active', paused_reason: null, consecutive_failures: 0 };
}

/** 직원 화면이 읽는 칸 — 목록·만들기·멈추기 라우트가 함께 쓴다 */
export const SCHEDULE_COLUMNS = 'id, agent_id, app_version, inputs, document_ids, frequency, weekday, month_day, run_hour, run_minute, status, paused_reason, admin_paused_at, next_run_at, last_run_at, last_status, last_error, last_conversation_id, consecutive_failures, run_count, created_at, notify_on_success, export_hwpx, files, time_zone';

/** DB 행 중 화면이 보는 칸. 실행 조건·사용자 id·부서는 내보내지 않는다 */
export type AppScheduleRowLike = {
  id: string; agent_id: string; app_version: number; inputs: Record<string, string>;
  /** 문서함에서 고른 문서(0062) — 실행 때 새 판을 따라간다 */
  document_ids?: string[] | null;
  frequency: string; weekday: number | null; month_day: number | null; run_hour: number; run_minute: number;
  /** (0119) IANA 시간대 — 없으면 한국 시간 */
  time_zone?: string | null;
  status: string; paused_reason: string | null; admin_paused_at?: string | null; next_run_at: string; last_run_at: string | null;
  last_status: string | null; last_error: string | null; last_conversation_id: string | null;
  consecutive_failures: number; run_count: number; created_at: string;
  /** 실행을 마치면 메일로 알림(0069) */
  notify_on_success?: boolean | null;
  /** 결과를 한글 파일로도 만들기(0071) */
  export_hwpx?: boolean | null;
  /** 예약이 가진 올린 파일 사본(0073) — [{id,name,size,path}], 읽기는 schedule-file-spec.ts */
  files?: unknown;
};

export type AppScheduleView = {
  id: string; agentId: string; appName: string; appVersion: number; inputs: Record<string, string>;
  /** 문서함에서 고른 문서 수(0062) — 이름은 실행 결과의 근거 문서에서 본다 */
  documentCount: number;
  /** 고른 문서 id — 예약 고치기 화면이 미리 골라 둔다(내 예약만 보인다) */
  documentIds: string[];
  spec: AppScheduleSpec; description: string; status: 'active' | 'paused'; pausedReason: string | null;
  /** 관리자가 멈춘 예약(0050) — 직원이 다시 켜지 못한다 */
  adminPaused: boolean;
  nextRunAt: string; lastRunAt: string | null; lastStatus: 'completed' | 'failed' | null; lastError: string | null;
  lastConversationId: string | null; consecutiveFailures: number; runCount: number; overdue: boolean; createdAt: string;
  /** 실행을 마치면 메일로 알림(0069) — 결과 글은 메일에 싣지 않고 링크만 */
  notifyOnSuccess: boolean;
  /** 켜진 예약인데 기관이 예약 실행을 꺼 두어 돌지 않는다(0070) */
  heldByOrg: boolean;
  /** 넘기는 까닭이 기관 정지·종료(2026-11-19) — 화면이 `SCHEDULE_ORG_STOPPED`를 보인다 */
  orgStopped: boolean;
  /** 결과를 표준 보고서 한글 파일로도 만든다(0071) */
  exportHwpx: boolean;
  /** 예약에 저장한 올린 파일(0073) — 이름·크기만(저장소 경로는 내보내지 않는다) */
  files: { id: string; name: string; size: number }[];
};

/** 예약 파일 칸 → 화면 목록(경로를 뗀다). 꼴이 틀린 원소는 버린다 */
function fileViews(raw: unknown): { id: string; name: string; size: number }[] {
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((f) => {
    const { id, name, size } = (f && typeof f === 'object' ? f : {}) as Record<string, unknown>;
    return typeof id === 'string' && typeof name === 'string' && typeof size === 'number' ? [{ id, name, size }] : [];
  });
}

export function specOfRow(row: Pick<AppScheduleRowLike, 'frequency' | 'weekday' | 'month_day' | 'run_hour' | 'run_minute' | 'time_zone'>): AppScheduleSpec {
  const parsed = parseScheduleSpec({ frequency: row.frequency, weekday: row.weekday, month_day: row.month_day, hour: row.run_hour, minute: row.run_minute, time_zone: row.time_zone });
  if (!parsed.ok) throw new Error(`예약 행이 깨졌습니다: ${parsed.message}`);
  return parsed.value;
}

export function scheduleView(row: AppScheduleRowLike, appName: string | null, nowMs: number, orgDisabled: boolean | 'stopped' = false): AppScheduleView {
  const spec = specOfRow(row);
  const status = row.status === 'paused' ? 'paused' : 'active';
  return {
    id: row.id, agentId: row.agent_id, appName: appName ?? '삭제된 앱', appVersion: row.app_version, inputs: row.inputs ?? {},
    documentCount: row.document_ids?.length ?? 0, documentIds: row.document_ids ?? [],
    spec, description: describeSchedule(spec), status, pausedReason: row.paused_reason, adminPaused: Boolean(row.admin_paused_at),
    nextRunAt: row.next_run_at, lastRunAt: row.last_run_at,
    lastStatus: row.last_status === 'completed' || row.last_status === 'failed' ? row.last_status : null,
    lastError: row.last_error, lastConversationId: row.last_conversation_id,
    consecutiveFailures: row.consecutive_failures, runCount: row.run_count,
    overdue: status === 'active' && !orgDisabled && Date.parse(row.next_run_at) < nowMs - SCHEDULE_OVERDUE_MS,
    createdAt: row.created_at, notifyOnSuccess: row.notify_on_success === true, heldByOrg: status === 'active' && Boolean(orgDisabled), orgStopped: status === 'active' && orgDisabled === 'stopped', exportHwpx: row.export_hwpx === true,
    files: fileViews(row.files),
  };
}

/** 예약 한 줄의 상태 칩 — 멈춤 > 지연 > 마지막 실패 > 활성 */
export function scheduleBadge(s: AppScheduleView): { label: string; tone: 'neutral' | 'warn' | 'ok' | 'busy' | 'bad' } {
  if (s.adminPaused) return { label: '관리자가 멈춤', tone: 'bad' };
  if (s.status === 'paused') return { label: '멈춤', tone: 'warn' };
  if (s.heldByOrg) return { label: '기관이 멈춤', tone: 'bad' };
  if (s.overdue) return { label: '실행 지연', tone: 'bad' };
  if (s.lastStatus === 'failed') return { label: `실패 ${s.consecutiveFailures}회`, tone: 'warn' };
  return { label: '예약 중', tone: 'ok' };
}
