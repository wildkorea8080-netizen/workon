// src/lib/apps/outbound/spec.ts
// 앱 결과를 외부 시스템으로 보내기(0076) — 규칙만(아무것도 import하지 않는다: 화면도 읽는다).
// 보낼 곳 = 기관 전체 관리자가 승인한 https 주소. 앱 정의의 `deliverEndpointId`가 고른 보낼 곳으로, 실행을 마친 결과 글을 서명해 보낸다.

/** 기관에 쓸 수 있는 보낼 곳 수 */
export const OUTBOUND_MAX_ENDPOINTS = 10;
export const OUTBOUND_NAME_MAX = 60;
export const OUTBOUND_URL_MAX = 500;
/** 서명 비밀값 앞머리 — 받는 쪽이 어느 비밀값인지 알아보게 */
export const OUTBOUND_SECRET_PREFIX = 'wo_out_';
/** 보내는 결과 글 상한 — 넘으면 앞부분만 싣고 `truncated: true` */
export const OUTBOUND_TEXT_MAX = 50_000;
/** 결과 한글 파일을 함께 실을 때(2026-11-10) 파일 상한 — 넘으면 파일 없이 보내고 `file_omitted: 'too_large'` */
export const OUTBOUND_FILE_MAX_BYTES = 5 * 1024 * 1024;
export const OUTBOUND_FILE_CONTENT_TYPE = 'application/hwp+zip';
/** 받는 쪽 접수 응답(2026-11-10, 0080) — 2xx 응답 몸에서 이만큼만 읽는다 */
export const OUTBOUND_RECEIPT_MAX_BYTES = 4096;
export const OUTBOUND_RECEIPT_REF_MAX = 100;
export const OUTBOUND_RECEIPT_URL_MAX = 500;
/** 직원의 '보낸 결과' 목록 길이 */
export const OUTBOUND_MY_DELIVERIES_LIMIT = 20;
/** 한 번 보낼 때 기다리는 시간 */
export const OUTBOUND_TIMEOUT_MS = 8_000;
/** 시도 상한 — 첫 시도 포함 */
export const OUTBOUND_MAX_ATTEMPTS = 5;
/** n번째 시도가 실패한 뒤 다음 시도까지(1·5·30분·2시간) */
export const OUTBOUND_BACKOFF_MS = [60_000, 300_000, 1_800_000, 7_200_000];
/** `sending`으로 이만큼 지나면 실행기가 죽은 것으로 보고 다시 차지한다 */
export const OUTBOUND_STALE_MS = 600_000;
export const OUTBOUND_REVOKE_REASON_MIN = 5;
/** 보내기 전 확인(0078) — 실행한 직원이 이 기간 안에 '보내기'를 누르지 않으면 보내지 않는다 */
export const OUTBOUND_APPROVAL_DAYS = 7;
export const OUTBOUND_APPROVAL_MS = OUTBOUND_APPROVAL_DAYS * 86_400_000;
/** 확인 목록에 미리 보이는 결과 글 길이 */
export const OUTBOUND_PREVIEW_CHARS = 600;
export const OUTBOUND_APPROVAL_EXPIRED = `${OUTBOUND_APPROVAL_DAYS}일 안에 확인하지 않아 보내지 않았습니다.`;
export const OUTBOUND_APPROVAL_ENDPOINT_GONE = '보낼 곳이 회수돼 보낼 수 없습니다.';
export const OUTBOUND_WHOLE_ORG_ONLY = '보낼 곳은 기관 전체 관리자(최상위 부서 소속 관리자)만 관리할 수 있습니다.';

/** 보낼 곳마다 정하는 동작 수(0081) */
export const OUTBOUND_MAX_ACTIONS = 5;
export const OUTBOUND_ACTION_LABEL_MAX = 40;
export const OUTBOUND_ACTION_KEY = /^[a-z][a-z0-9_]{0,31}$/;
/** 받는 쪽이 알아듣는 동작 — 키(영문 소문자·숫자·_)와 화면 이름. 예 draft=기안 임시 저장 */
export type OutboundAction = { key: string; label: string };
export const OUTBOUND_ACTION_REQUIRED = '보낼 곳이 동작을 정해 두었습니다 — 앱 설정의 \'결과를 보낼 곳\'에서 동작을 골라 주세요.';
export const OUTBOUND_ACTION_GONE = '앱이 고른 동작이 보낼 곳에서 없어졌습니다 — 앱 설정에서 동작을 다시 골라 주세요.';

export const OUTBOUND_HEADERS = {
  action: 'X-Workon-Action',
  event: 'X-Workon-Event',
  delivery: 'X-Workon-Delivery',
  timestamp: 'X-Workon-Timestamp',
  signature: 'X-Workon-Signature',
  idempotency: 'Idempotency-Key',
} as const;
export const OUTBOUND_EVENT = 'app.run.completed';

export type OutboundStatus = 'awaiting_approval' | 'pending' | 'sending' | 'sent' | 'gave_up' | 'rejected';
export const OUTBOUND_STATUS_LABELS: Record<OutboundStatus, string> = {
  awaiting_approval: '직원 확인 기다림', pending: '보낼 차례 기다림', sending: '보내는 중', sent: '보냄', gave_up: '그만둠', rejected: '직원이 보내지 않음',
};
export type OutboundDecision = 'approve' | 'reject';

/** 확인 기다림 기록이 '보내기'를 받을 수 있는 마지막 시각(ms) */
export function approvalExpiresAt(createdAtIso: string): number {
  return Date.parse(createdAtIso) + OUTBOUND_APPROVAL_MS;
}

export function parseDecision(raw: unknown): OutboundDecision | null {
  const body = raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw as Record<string, unknown>) : null;
  return body?.decision === 'approve' || body?.decision === 'reject' ? body.decision : null;
}

export interface OutboundEndpointView {
  id: string;
  name: string;
  /** 화면에는 주소 전체를 보인다(관리자 화면만 — 직원 화면에는 이름만) */
  url: string;
  secretPrefix: string;
  /** 보내기 전 실행한 직원이 확인한다(0078) */
  requireApproval: boolean;
  /** 받는 쪽 동작(0081) — 비면 동작 없이 보낸다 */
  actions: OutboundAction[];
  createdAt: string;
  createdByName: string | null;
  revokedAt: string | null;
  revokedReason: string | null;
}
/** 직원이 확인할 결과(0078) — 이 직원이 실행한 결과만 */
export interface OutboundApprovalView {
  id: string;
  agentId: string;
  appName: string;
  endpointName: string;
  conversationId: string | null;
  createdAt: string;
  expiresAt: string;
  /** 결과 글 앞부분 — 전체는 대화에서 본다 */
  preview: string;
  truncated: boolean;
}
export interface OutboundDeliveryView {
  id: string;
  endpointName: string;
  appName: string;
  status: OutboundStatus;
  attempts: number;
  lastStatus: number | null;
  lastError: string | null;
  createdAt: string;
  sentAt: string | null;
  nextAttemptAt: string | null;
  /** 보내기 전 확인을 누가·언제 했는지(보냄·보내지 않음) */
  decidedAt: string | null;
  decidedByName: string | null;
  /** 받는 쪽 접수 번호(0080) */
  receiptRef?: string | null;
}

const CONTROL = /[\p{Cc}\p{Cf}]/u;

/**
 * 보낼 곳 주소 꼴 — https만, 사용자 정보 없음, 포트는 없거나 443, 조각(#) 없음, 이름이 IP 꼴이면 사설·특수 주소가 아니어야 한다.
 * 이름(도메인)이 가리키는 주소는 서버가 풀어서 따로 본다(`url-guard.ts`) — 여기서는 꼴만
 */
export function parseOutboundUrl(raw: unknown): { ok: true; url: string; host: string } | { ok: false; message: string } {
  const bad = (message: string) => ({ ok: false as const, message });
  if (typeof raw !== 'string') return bad('보낼 주소를 입력해 주세요.');
  const text = raw.trim();
  if (!text || text.length > OUTBOUND_URL_MAX || CONTROL.test(text)) return bad(`보낼 주소는 ${OUTBOUND_URL_MAX}자 안의 https 주소여야 합니다.`);
  let u: URL;
  try { u = new URL(text); } catch { return bad('보낼 주소를 읽지 못했습니다. https://로 시작하는 주소를 입력해 주세요.'); }
  if (u.protocol !== 'https:') return bad('보낼 주소는 https만 받습니다.');
  if (u.username || u.password) return bad('주소에 아이디·비밀번호를 넣을 수 없습니다. 받는 쪽은 서명으로 확인하세요.');
  if (u.port && u.port !== '443') return bad('보낼 주소의 포트는 443(기본)만 받습니다.');
  if (u.hash) return bad('주소에 #조각을 넣을 수 없습니다.');
  const host = u.hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (!host || host === 'localhost' || /\.(localhost|local|internal|intranet|lan|home|corp)$/.test(host) || !host.includes('.') && !host.includes(':')) {
    return bad('내부망 주소로는 보낼 수 없습니다. 인터넷에서 열리는 https 주소를 입력해 주세요.');
  }
  if (isIpLiteral(host) && isPrivateAddress(host)) return bad('내부망·특수 IP 주소로는 보낼 수 없습니다.');
  return { ok: true, url: u.toString(), host };
}

/**
 * 동작 목록 읽기(0081) — 없으면 빈 목록. 글이면 한 줄에 하나 `키=이름`(또는 `키: 이름`), 배열이면 `{ key, label }`.
 * 키는 영문 소문자로 시작·영문 소문자·숫자·_ 32자, 이름은 1~40자(제어 글자 없음), 키는 겹치지 않게, 5개까지
 */
export function parseActions(raw: unknown): { ok: true; actions: OutboundAction[] } | { ok: false; message: string } {
  if (raw === undefined || raw === null || raw === '') return { ok: true, actions: [] };
  let items: Array<{ key: unknown; label: unknown }>;
  if (typeof raw === 'string') {
    items = raw.split(/\r?\n/).map((l) => l.trim()).filter(Boolean).map((l) => {
      const m = /^([^=:]+)[=:](.*)$/.exec(l);
      return m ? { key: m[1].trim(), label: m[2].trim() } : { key: l, label: '' };
    });
  } else if (Array.isArray(raw)) {
    items = raw.map((a) => (a && typeof a === 'object' ? (a as { key: unknown; label: unknown }) : { key: null, label: null }));
  } else return { ok: false, message: '동작 목록을 확인해 주세요.' };
  if (items.length > OUTBOUND_MAX_ACTIONS) return { ok: false, message: `동작은 ${OUTBOUND_MAX_ACTIONS}개까지 정할 수 있습니다.` };
  const actions: OutboundAction[] = [];
  for (const it of items) {
    const key = typeof it.key === 'string' ? it.key.trim() : '';
    const label = typeof it.label === 'string' ? it.label.trim().replace(/\s+/g, ' ') : '';
    if (!OUTBOUND_ACTION_KEY.test(key)) return { ok: false, message: `동작 키 '${key.slice(0, 32)}'는 영문 소문자로 시작하고 영문 소문자·숫자·_만 32자까지 쓸 수 있습니다(예: draft=기안 임시 저장).` };
    if (!label || label.length > OUTBOUND_ACTION_LABEL_MAX || CONTROL.test(label)) return { ok: false, message: `동작 '${key}'의 이름을 ${OUTBOUND_ACTION_LABEL_MAX}자 안으로 적어 주세요(예: ${key}=기안 임시 저장).` };
    if (actions.some((a) => a.key === key)) return { ok: false, message: `동작 키 '${key}'가 두 번 나옵니다.` };
    actions.push({ key, label });
  }
  return { ok: true, actions };
}

/** DB 칸 → 동작 목록(꼴이 틀린 원소는 버림) */
export function actionsOf(raw: unknown): OutboundAction[] {
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((a) => (a && typeof a === 'object' && typeof (a as OutboundAction).key === 'string' && OUTBOUND_ACTION_KEY.test((a as OutboundAction).key) && typeof (a as OutboundAction).label === 'string'
    ? [{ key: (a as OutboundAction).key, label: (a as OutboundAction).label.slice(0, OUTBOUND_ACTION_LABEL_MAX) }] : [])).slice(0, OUTBOUND_MAX_ACTIONS);
}

/** 보낼 때 쓸 동작 — 보낼 곳이 동작을 정했으면 기록의 동작이 그중 하나여야 하고, 정하지 않았으면 동작 없이(기록에 동작이 남아 있으면 그만둠) */
export function resolveAction(actions: OutboundAction[], key: string | null | undefined): { ok: true; action: OutboundAction | null } | { ok: false; message: string } {
  if (!key) return actions.length ? { ok: false, message: OUTBOUND_ACTION_REQUIRED } : { ok: true, action: null };
  const found = actions.find((a) => a.key === key);
  return found ? { ok: true, action: found } : { ok: false, message: OUTBOUND_ACTION_GONE };
}

export function parseCreateEndpoint(raw: unknown): { ok: true; value: { name: string; url: string; requireApproval: boolean; actions: OutboundAction[] } } | { ok: false; message: string } {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { ok: false, message: '보낼 곳 정보를 확인해 주세요.' };
  const body = raw as Record<string, unknown>;
  const name = typeof body.name === 'string' ? body.name.trim().replace(/\s+/g, ' ') : '';
  if (!name || name.length > OUTBOUND_NAME_MAX || CONTROL.test(name)) return { ok: false, message: `이름은 ${OUTBOUND_NAME_MAX}자 안으로 입력해 주세요.` };
  const url = parseOutboundUrl(body.url);
  if (!url.ok) return url;
  const actions = parseActions(body.actions);
  if (!actions.ok) return actions;
  return { ok: true, value: { name, url: url.url, requireApproval: body.require_approval === true, actions: actions.actions } };
}

export function parseRevokeReason(raw: unknown): { ok: true; reason: string } | { ok: false; message: string } {
  const reason = typeof raw === 'string' ? raw.trim().replace(/\s+/g, ' ') : '';
  if (reason.length < OUTBOUND_REVOKE_REASON_MIN || reason.length > 300 || CONTROL.test(reason)) return { ok: false, message: `회수 사유를 ${OUTBOUND_REVOKE_REASON_MIN}자 이상 300자 안으로 적어 주세요.` };
  return { ok: true, reason };
}

// ── IP 주소 판정(사설·특수 주소는 보내지 않는다 — SSRF 막기) ────────────────────

export function isIpLiteral(host: string): boolean {
  return /^\d{1,3}(\.\d{1,3}){3}$/.test(host) || host.includes(':');
}

function v4Parts(ip: string): number[] | null {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(ip);
  if (!m) return null;
  const parts = m.slice(1).map(Number);
  return parts.every((p) => p >= 0 && p <= 255) ? parts : null;
}

function privateV4([a, b, c]: number[]): boolean {
  return a === 0 || a === 10 || a === 127 || a >= 224
    || (a === 100 && b >= 64 && b <= 127)
    || (a === 169 && b === 254)
    || (a === 172 && b >= 16 && b <= 31)
    || (a === 192 && b === 168)
    || (a === 192 && b === 0 && (c === 0 || c === 2))
    || (a === 198 && (b === 18 || b === 19))
    || (a === 198 && b === 51 && c === 100)
    || (a === 203 && b === 0 && c === 113);
}

/** 사설·되돌이·링크 로컬·멀티캐스트·문서용·꼴이 틀린 주소면 참(꼴을 모르면 막는다) */
export function isPrivateAddress(ip: string): boolean {
  const host = ip.toLowerCase().replace(/^\[|\]$/g, '').replace(/%.*$/, '');
  const v4 = v4Parts(host);
  if (v4) return privateV4(v4);
  if (!host.includes(':')) return true;
  // IPv4를 품은 IPv6(::ffff:10.0.0.1 · ::10.0.0.1)
  const embedded = /(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/.exec(host);
  if (embedded) { const p = v4Parts(embedded[1]); return p ? privateV4(p) : true; }
  if (host === '::' || host === '::1') return true;
  const first = host.split(':')[0];
  if (!/^[0-9a-f]{0,4}$/.test(first)) return true;
  const word = parseInt(first || '0', 16);
  return (word & 0xfe00) === 0xfc00 // fc00::/7 고유 로컬
    || (word & 0xffc0) === 0xfe80 // fe80::/10 링크 로컬
    || (word & 0xff00) === 0xff00 // ff00::/8 멀티캐스트
    || word === 0x2001 && /^2001:0?db8:/.test(host) // 문서용
    || word === 0 && !embedded; // ::/8 남은 것(옛 호환 주소 등)
}

// ── 보낸 결과 판정 ──────────────────────────────────────────────────────

/** 받는 쪽이 돌려준 접수 정보 — 접수 번호(문서번호 등)·받는 쪽 화면 주소(https). 둘 중 하나 이상 */
export type OutboundReceipt = { reference: string | null; url: string | null };

export type AttemptOutcome =
  | { kind: 'sent'; status: number; receipt?: OutboundReceipt }
  | { kind: 'retry'; status: number | null; error: string }
  | { kind: 'give_up'; status: number | null; error: string };

/** 응답 상태로 다음 할 일 — 2xx 보냄, 3xx(따라가지 않음)·4xx(408·429 빼고)는 그만둠, 그 밖·연결 실패는 다시 */
export function outcomeForStatus(status: number): AttemptOutcome {
  if (status >= 200 && status < 300) return { kind: 'sent', status };
  if (status >= 300 && status < 400) return { kind: 'give_up', status, error: '다른 주소로 보내라는 응답(리다이렉트)은 따르지 않습니다. 보낼 곳 주소를 확인해 주세요.' };
  if (status === 408 || status === 429) return { kind: 'retry', status, error: `받는 쪽이 ${status}로 답했습니다(잠시 뒤 다시 보냄).` };
  if (status >= 400 && status < 500) return { kind: 'give_up', status, error: `받는 쪽이 ${status}로 거절했습니다(서명·주소를 확인해 주세요).` };
  return { kind: 'retry', status, error: `받는 쪽이 ${status}로 답했습니다(잠시 뒤 다시 보냄).` };
}

/** 이번 시도(1부터)가 실패한 뒤 — 다시 보낼 때(ms 시각) 또는 그만둠(null) */
export function nextAttemptAt(attempt: number, nowMs: number): number | null {
  if (attempt >= OUTBOUND_MAX_ATTEMPTS) return null;
  return nowMs + OUTBOUND_BACKOFF_MS[Math.min(attempt, OUTBOUND_BACKOFF_MS.length) - 1];
}

/** 함께 싣는 결과 한글 파일(2026-11-10) — 실었거나(base64), 상한을 넘어 뺐거나 */
export type OutboundFile =
  | { name: string; size: number; sha256: string; base64: string }
  | { omitted: 'too_large'; size: number };

/** 보내는 몸 — 결과 글(상한에서 자름)과 앱·실행 식별자만(+ 앱이 고르면 결과 한글 파일). 입력값·중간 단계·직원 정보는 싣지 않는다 */
export function buildOutboundPayload(input: {
  deliveryId: string; sentAt: string;
  app: { id: string; name: string };
  run: { messageId: string; conversationId: string; completedAt: string };
  text: string;
  file?: OutboundFile;
  /** 받는 쪽 동작(0081) */
  action?: OutboundAction | null;
}): string {
  const truncated = input.text.length > OUTBOUND_TEXT_MAX;
  const result: Record<string, unknown> = { text: truncated ? input.text.slice(0, OUTBOUND_TEXT_MAX) : input.text, truncated };
  if (input.file && 'omitted' in input.file) {
    result.file = null;
    result.file_omitted = input.file.omitted;
  } else if (input.file) {
    result.file = { name: input.file.name, content_type: OUTBOUND_FILE_CONTENT_TYPE, size: input.file.size, sha256: input.file.sha256, encoding: 'base64', data: input.file.base64 };
  }
  return JSON.stringify({
    event: OUTBOUND_EVENT,
    delivery_id: input.deliveryId,
    sent_at: input.sentAt,
    ...(input.action ? { action: { key: input.action.key, label: input.action.label } } : {}),
    app: { id: input.app.id, name: input.app.name },
    run: { message_id: input.run.messageId, conversation_id: input.run.conversationId, completed_at: input.run.completedAt },
    result,
  });
}

/**
 * 받는 쪽 2xx 응답 몸 → 접수 정보. 꼴은 `{"receipt": {"reference": "문서번호", "url": "https://…"}}`만 읽는다(다른 칸·JSON 아님·빈 값은 null).
 * 번호는 제어·서식 글자를 빼고 100자, 주소는 https·아이디 없음·500자만(그 밖은 버림). 받는 쪽 글이라 다듬은 값만 화면에 보인다
 */
export function parseOutboundReceipt(text: string): OutboundReceipt | null {
  let body: unknown;
  try { body = JSON.parse(text); } catch { return null; }
  const receipt = body && typeof body === 'object' && !Array.isArray(body) ? (body as Record<string, unknown>).receipt : null;
  if (!receipt || typeof receipt !== 'object' || Array.isArray(receipt)) return null;
  const r = receipt as Record<string, unknown>;
  const rawRef = typeof r.reference === 'string' ? r.reference : typeof r.reference === 'number' && Number.isFinite(r.reference) ? String(r.reference) : '';
  const ref = rawRef.normalize('NFC').replace(/[\p{Cc}\p{Cf}]/gu, ' ').replace(/\s+/g, ' ').trim().slice(0, OUTBOUND_RECEIPT_REF_MAX);
  let url: string | null = null;
  if (typeof r.url === 'string' && r.url.length <= OUTBOUND_RECEIPT_URL_MAX && !CONTROL.test(r.url)) {
    try {
      const u = new URL(r.url.trim());
      if (u.protocol === 'https:' && !u.username && !u.password && u.toString().length <= OUTBOUND_RECEIPT_URL_MAX) url = u.toString();
    } catch { /* 버림 */ }
  }
  return ref || url ? { reference: ref || null, url } : null;
}

/** 직원이 보는 '보낸 결과' 한 줄(0080) — 자기 결과만. 결과 글·보낼 곳 주소는 싣지 않는다 */
export interface OutboundMyDeliveryView {
  id: string; appName: string; endpointName: string; status: OutboundStatus; attempts: number;
  createdAt: string; sentAt: string | null; nextAttemptAt: string | null; lastError: string | null;
  receiptRef: string | null; receiptUrl: string | null; conversationId: string | null;
  /** 직원이 '다시 보내기'를 누를 수 있는지(2026-11-10) — 실제로 보내 보고 그만둔 기록·7일 안·보낼 곳이 아직 쓰임 */
  retryable?: boolean;
}

/** 다시 보내기를 받는 기간(그만둔 기록이 만들어진 때부터) */
export const OUTBOUND_RETRY_WINDOW_MS = OUTBOUND_APPROVAL_MS;
export const OUTBOUND_RETRY_NOTE = '직원이 다시 보내기를 눌렀습니다.';
/**
 * 그만둔 보내기를 직원이 다시 보낼 수 있는지 — **실제로 보내 보고(시도 1번 이상) 그만둔 것만**. 시도 0번인 그만둠(확인 기한 지남·보낼 곳 회수·동작 없어짐)은
 * 사람이 정한 일이거나 설정을 고쳐야 하는 일이라 받지 않는다(다시 보내기가 보내기 전 확인을 건너뛰지 않게)
 */
export function canRetryDelivery(d: { status: string; attempts: number; created_at: string }, endpointActive: boolean, nowMs: number): boolean {
  return d.status === 'gave_up' && d.attempts >= 1 && endpointActive && Date.parse(d.created_at) > nowMs - OUTBOUND_RETRY_WINDOW_MS;
}

/** 받는 쪽 확인 방법 — 안내 글(화면·문서 공용) */
export const OUTBOUND_VERIFY_HINT = `받는 쪽은 ${OUTBOUND_HEADERS.signature} 머리글이 sha256=HMAC-SHA256(비밀값, "{${OUTBOUND_HEADERS.timestamp}}." + 받은 본문 그대로)의 16진수와 같은지, 시각이 5분 안인지 보세요. 같은 ${OUTBOUND_HEADERS.delivery}(${OUTBOUND_HEADERS.idempotency})가 다시 오면 한 번만 처리하세요. 받은 뒤 2xx 응답 몸에 {"receipt":{"reference":"접수 번호","url":"https://…"}}를 주면 실행한 직원 화면에 보입니다(선택).`;
