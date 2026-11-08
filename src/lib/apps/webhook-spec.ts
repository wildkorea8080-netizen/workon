// src/lib/apps/webhook-spec.ts
// 입력형 앱 외부 연동(Webhook)의 순수 규칙 — 화면과 서버가 함께 쓴다(아무것도 import하지 않는다).

export const WEBHOOK_TOKEN_PREFIX = 'wo_wh_';
/** 화면에 남기는 토큰 앞부분 길이(접두 포함) — 어느 토큰인지 알아보는 데만 */
export const WEBHOOK_SHOWN_PREFIX_CHARS = 12;
/** 한 사람이 둘 수 있는 쓸 수 있는(회수·만료 안 된) 연동 수 */
export const APP_MAX_WEBHOOKS_PER_USER = 5;
/** 같은 토큰으로 다음 호출까지 기다려야 하는 시간 — 재시도 폭주·중복 실행을 막는다 */
export const WEBHOOK_MIN_INTERVAL_SECONDS = 60;
/** 토큰 하나의 하루(한국 날짜) 호출 상한 */
export const WEBHOOK_DAILY_LIMIT = 100;
/** 고를 수 있는 유효 기간(일). 무기한 토큰은 만들지 않는다 */
export const WEBHOOK_EXPIRY_DAYS = [30, 90, 365] as const;
/** 호출 본문 상한 — 입력 전체 16,000자(renderAppInput)에 JSON 여유를 둔다 */
export const WEBHOOK_MAX_BODY_BYTES = 64 * 1024;
export const WEBHOOK_TITLE_PREFIX = '[연동] ';
/** 기관 전체 외부 연동 스위치(0068)가 꺼져 있을 때 — 외부 호출 403·새 연동 거절·직원 목록 안내에 같은 문구 */
export const WEBHOOK_ORG_DISABLED = '기관 관리자가 외부 연동(Webhook)을 꺼 두었습니다. 다시 켤 때까지 연동으로 앱을 실행할 수 없습니다.';
export const WEBHOOK_ORG_DISABLED_CREATE = '기관 관리자가 외부 연동(Webhook)을 꺼 두어 새 연동을 만들 수 없습니다.';
/** 기관 전체 스위치 상태 — 관리자 화면. `canChange`는 기관 전체를 관리하는 관리자만 참 */
export type WebhookSwitchView = { disabled: boolean; disabledAt: string | null; reason: string | null; canChange: boolean };

/** 재시도 중복 막기 머리글(0051). 같은 연동·같은 키는 24시간 동안 앱을 다시 돌리지 않고 처음 결과를 돌려준다 */
export const IDEMPOTENCY_HEADER = 'Idempotency-Key';
export const IDEMPOTENCY_WINDOW_HOURS = 24;
const IDEMPOTENCY_KEY = /^[A-Za-z0-9_.:-]{1,100}$/;

/** Idempotency-Key 머리글 — 없으면 null(키 없이 처리), 꼴이 틀리면 거절. 앞뒤 공백은 뗀다 */
export function parseIdempotencyKey(header: string | null): { ok: true; key: string | null } | { ok: false; message: string } {
  if (header === null) return { ok: true, key: null };
  const key = header.trim();
  if (!IDEMPOTENCY_KEY.test(key)) return { ok: false, message: `${IDEMPOTENCY_HEADER}는 영문·숫자·_.:- 1~100자여야 합니다.` };
  return { ok: true, key };
}

/** 입력값을 키 순서대로 맞춘 JSON — 같은 내용이면 키 순서가 달라도 같은 글(해시는 서버가 낸다) */
export function canonicalInputs(inputs: Record<string, string>): string {
  return JSON.stringify(Object.keys(inputs).sort().map((key) => [key, inputs[key]]));
}

export type WebhookExpiryDays = (typeof WEBHOOK_EXPIRY_DAYS)[number];

/** 만들기 요청의 이름·유효 기간. 틀리면 한국어 이유 */
export function parseWebhookCreate(raw: unknown): { ok: true; name: string; expiryDays: WebhookExpiryDays } | { ok: false; message: string } {
  if (!raw || typeof raw !== 'object') return { ok: false, message: '연동 이름과 유효 기간을 확인해 주세요.' };
  const r = raw as Record<string, unknown>;
  const name = typeof r.name === 'string' ? r.name.normalize('NFC').replace(/[\p{Cc}\p{Cf}]/gu, '').replace(/\s+/g, ' ').trim() : '';
  if (!name) return { ok: false, message: '연동 이름을 적어 주세요(예: 민원 시스템).' };
  if (name.length > 40) return { ok: false, message: '연동 이름은 40자까지입니다.' };
  const days = typeof r.expiry_days === 'string' ? Number(r.expiry_days) : r.expiry_days;
  if (!WEBHOOK_EXPIRY_DAYS.includes(days as WebhookExpiryDays)) return { ok: false, message: `유효 기간은 ${WEBHOOK_EXPIRY_DAYS.join('·')}일 중 하나입니다.` };
  return { ok: true, name, expiryDays: days as WebhookExpiryDays };
}

/** Authorization 머리글에서 연동 토큰을 꺼낸다. 꼴이 다르면 null(서버는 그대로 401) */
export function bearerWebhookToken(header: string | null): string | null {
  const m = /^Bearer (wo_wh_[A-Za-z0-9_-]{43})$/.exec(header ?? '');
  return m ? m[1] : null;
}

/** 직원 화면이 읽는 칸(토큰 해시·사용자·부서 없음) — 목록·만들기·회수 라우트가 함께 쓴다 */
export const WEBHOOK_COLUMNS = 'id, agent_id, app_version, document_ids, name, token_prefix, status, expires_at, revoked_at, revoked_reason, last_used_at, use_count, last_status, last_error, last_conversation_id, created_at';

export type AppWebhookRowLike = {
  id: string; agent_id: string; app_version: number; name: string; token_prefix: string; status: string;
  /** 문서함에서 고른 문서(0063) — 호출마다 새 판을 따라간다 */
  document_ids?: string[] | null;
  expires_at: string; revoked_at: string | null; revoked_reason?: string | null; last_used_at: string | null; use_count: number;
  last_status: string | null; last_error: string | null; last_conversation_id: string | null; created_at: string;
};

export type AppWebhookView = {
  id: string; agentId: string; appName: string; appVersion: number; name: string; tokenPrefix: string;
  /** 문서함에서 고른 문서 수(0063) */
  documentCount: number;
  state: 'active' | 'revoked' | 'expired'; expiresAt: string; revokedAt: string | null;
  /** 관리자 회수·계정 탈퇴일 때의 까닭(0050). 직원이 스스로 회수했으면 null */
  revokedReason: string | null; lastUsedAt: string | null; useCount: number;
  lastStatus: 'completed' | 'failed' | null; lastError: string | null; lastConversationId: string | null; createdAt: string;
  /** 쓰는 중이지만 기관이 외부 연동을 꺼 두어 지금은 돌지 않는다(0068) — 토큰은 그대로, 다시 켜면 쓴다 */
  blockedByOrg: boolean;
};

/** DB 행 → 화면. 토큰 해시·사용자·부서는 내보내지 않는다 */
export function webhookView(row: AppWebhookRowLike, appName: string | null, nowMs: number, orgDisabled = false): AppWebhookView {
  const state = row.status === 'revoked' ? 'revoked' : Date.parse(row.expires_at) <= nowMs ? 'expired' : 'active';
  return {
    id: row.id, agentId: row.agent_id, appName: appName ?? '삭제된 앱', appVersion: row.app_version, name: row.name, tokenPrefix: row.token_prefix,
    documentCount: row.document_ids?.length ?? 0,
    state, expiresAt: row.expires_at, revokedAt: row.revoked_at, revokedReason: row.revoked_reason ?? null, lastUsedAt: row.last_used_at, useCount: row.use_count,
    lastStatus: row.last_status === 'completed' || row.last_status === 'failed' ? row.last_status : null,
    lastError: row.last_error, lastConversationId: row.last_conversation_id, createdAt: row.created_at,
    blockedByOrg: orgDisabled && state === 'active',
  };
}

/** 화면에 보일 호출 예시(토큰은 만든 직후 한 번만 보인다) */
export function webhookCurlExample(origin: string, token: string, inputs: Record<string, string>): string {
  const body = JSON.stringify({ inputs }).replace(/'/g, "'\\''");
  return `curl -X POST '${origin}/api/apps/webhook' \\\n  -H 'Authorization: Bearer ${token}' \\\n  -H 'Content-Type: application/json' \\\n  -H '${IDEMPOTENCY_HEADER}: 요청마다-다른-값' \\\n  -d '${body}'`;
}
