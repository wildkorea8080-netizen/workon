import { SCHEDULE_OVERDUE_MS, describeSchedule, specOfRow, type AppScheduleFrequency } from '@/lib/apps/schedule-spec';
import type { WebhookSwitchView } from '@/lib/apps/webhook-spec';

/**
 * 앱 예약·연동 관리자 통제의 순수 규칙(0050) — 화면과 서버가 함께 쓴다. DB·저장소를 모른다.
 * 서버 동작은 `automation-admin.ts`, 설명은 docs/benchmarks/allganize/APP_AUTOMATION_ADMIN.md.
 */

export const ADMIN_REASON_MIN = 5;
export const ADMIN_REASON_MAX = 200;
/** 관리 목록 한 번에 읽는 행 상한(종류마다) */
export const ADMIN_AUTOMATION_LIMIT = 500;
export const PERSONAL_APP_LABEL = '개인 앱(이름 비공개)';
export const WITHDRAWAL_REVOKED_REASON = '계정 탈퇴로 회수했습니다.';
export const ADMIN_UNLOCKED_REASON = '관리자가 잠금을 풀었습니다. 다시 켜면 예약이 이어집니다.';
export const ADMIN_LOCKED_MESSAGE = '관리자가 멈춘 예약입니다. 다시 켜려면 기관 관리자에게 문의해 주세요.';

const clean = (s: string) => s.normalize('NFC').replace(/[\p{Cc}\p{Cf}]/gu, ' ').replace(/\s+/g, ' ').trim();

/** 관리자 조치 사유 — 5~200자(제어·서식 글자 지움). 감사 자료에 남고 직원 화면에도 보인다 */
export function parseAdminReason(raw: unknown): { ok: true; reason: string } | { ok: false; message: string } {
  const reason = typeof raw === 'string' ? clean(raw) : '';
  if (reason.length < ADMIN_REASON_MIN) return { ok: false, message: `사유를 ${ADMIN_REASON_MIN}자 이상 적어 주세요. 사유는 보안 로그에 남고 직원 화면에도 보입니다.` };
  if (reason.length > ADMIN_REASON_MAX) return { ok: false, message: `사유는 ${ADMIN_REASON_MAX}자까지입니다.` };
  return { ok: true, reason };
}

export const adminRevokedReason = (reason: string) => `관리자가 회수했습니다 — ${reason}`;
export const adminPausedReason = (reason: string) => `관리자가 멈췄습니다 — ${reason}`;

type Joined<T> = T | T[] | null;
const one = <T>(v: Joined<T>): T | null => (Array.isArray(v) ? v[0] ?? null : v);
type AgentJoin = { name: string; tier: string };
type UserJoin = { full_name: string | null; deleted_at: string | null };

export type AdminWebhookRow = {
  id: string; name: string; token_prefix: string; status: string; expires_at: string; revoked_at: string | null; revoked_reason: string | null;
  last_used_at: string | null; use_count: number; last_status: string | null; created_at: string; department_id: string;
  agent: Joined<AgentJoin>; owner: Joined<UserJoin>;
};
export type AdminScheduleRow = {
  id: string; frequency: string; weekday: number | null; month_day: number | null; run_hour: number; run_minute: number;
  status: string; paused_reason: string | null; admin_paused_at: string | null; next_run_at: string; last_run_at: string | null;
  last_status: string | null; consecutive_failures: number; run_count: number; created_at: string; department_id: string;
  agent: Joined<AgentJoin>; owner: Joined<UserJoin>;
};

export type AdminWebhookView = {
  id: string; name: string; appName: string; ownerName: string; departmentName: string | null; tokenPrefix: string;
  state: 'active' | 'revoked' | 'expired'; expiresAt: string; revokedAt: string | null; revokedReason: string | null;
  lastUsedAt: string | null; useCount: number; lastStatus: 'completed' | 'failed' | null; createdAt: string;
};
export type AdminScheduleView = {
  id: string; appName: string; ownerName: string; departmentName: string | null; description: string; frequency: AppScheduleFrequency;
  status: 'active' | 'paused'; pausedReason: string | null; adminPaused: boolean; nextRunAt: string; lastRunAt: string | null;
  lastStatus: 'completed' | 'failed' | null; consecutiveFailures: number; runCount: number; createdAt: string;
  /** 켜진 예약인데 예정 시각이 1시간 넘게 지났다 — 실행기가 멈춘 신호(직원 화면의 '실행 지연'과 같은 기준) */
  overdue: boolean;
};
/** 예약 실행기 상태(`schedule-health.ts`) — 실행기 도장은 서비스 전체, 숫자는 관리 범위 안 예약만. 읽지 못하면 null */
export type AdminRunnerStatus = { alive: boolean; lastRunAt: string | null; overdueCount: number; stuckClaimCount: number; problems: string[] };
/** `webhookSwitch` — 기관 전체 외부 연동 스위치(0068). 읽지 못하면 null(목록은 보인다) */
export type AdminAutomationList = { webhooks: AdminWebhookView[]; schedules: AdminScheduleView[]; truncated: boolean; runner: AdminRunnerStatus | null; webhookSwitch: WebhookSwitchView | null };

const appLabel = (agent: AgentJoin | null) => (!agent ? '삭제된 앱' : agent.tier === 'personal' ? PERSONAL_APP_LABEL : agent.name);
const ownerLabel = (owner: UserJoin | null) => (!owner ? '알 수 없음' : owner.deleted_at ? `${owner.full_name ?? '이름 없음'}(탈퇴)` : owner.full_name ?? '이름 없음');
const lastStatusOf = (s: string | null) => (s === 'completed' || s === 'failed' ? s : null);

/** 관리자용 연동 한 줄 — 토큰 해시·마지막 오류·결과 대화는 싣지 않는다 */
export function adminWebhookView(row: AdminWebhookRow, departmentName: string | null, nowMs: number): AdminWebhookView {
  return {
    id: row.id, name: row.name, appName: appLabel(one(row.agent)), ownerName: ownerLabel(one(row.owner)), departmentName, tokenPrefix: row.token_prefix,
    state: row.status === 'revoked' ? 'revoked' : Date.parse(row.expires_at) <= nowMs ? 'expired' : 'active',
    expiresAt: row.expires_at, revokedAt: row.revoked_at, revokedReason: row.revoked_reason,
    lastUsedAt: row.last_used_at, useCount: row.use_count, lastStatus: lastStatusOf(row.last_status), createdAt: row.created_at,
  };
}

/** 관리자용 예약 한 줄 — 입력값·마지막 오류·결과 대화는 싣지 않는다 */
export function adminScheduleView(row: AdminScheduleRow, departmentName: string | null, nowMs: number): AdminScheduleView {
  const spec = specOfRow(row);
  const status = row.status === 'paused' ? 'paused' : 'active';
  return {
    id: row.id, appName: appLabel(one(row.agent)), ownerName: ownerLabel(one(row.owner)), departmentName,
    description: describeSchedule(spec), frequency: spec.frequency,
    status, pausedReason: row.paused_reason, adminPaused: row.admin_paused_at !== null,
    nextRunAt: row.next_run_at, lastRunAt: row.last_run_at, lastStatus: lastStatusOf(row.last_status),
    consecutiveFailures: row.consecutive_failures, runCount: row.run_count, createdAt: row.created_at,
    overdue: status === 'active' && Date.parse(row.next_run_at) < nowMs - SCHEDULE_OVERDUE_MS,
  };
}

