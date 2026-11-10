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
/** 한 번 보낼 때 기다리는 시간 */
export const OUTBOUND_TIMEOUT_MS = 8_000;
/** 시도 상한 — 첫 시도 포함 */
export const OUTBOUND_MAX_ATTEMPTS = 5;
/** n번째 시도가 실패한 뒤 다음 시도까지(1·5·30분·2시간) */
export const OUTBOUND_BACKOFF_MS = [60_000, 300_000, 1_800_000, 7_200_000];
/** `sending`으로 이만큼 지나면 실행기가 죽은 것으로 보고 다시 차지한다 */
export const OUTBOUND_STALE_MS = 600_000;
export const OUTBOUND_REVOKE_REASON_MIN = 5;
export const OUTBOUND_WHOLE_ORG_ONLY = '보낼 곳은 기관 전체 관리자(최상위 부서 소속 관리자)만 관리할 수 있습니다.';

export const OUTBOUND_HEADERS = {
  event: 'X-Workon-Event',
  delivery: 'X-Workon-Delivery',
  timestamp: 'X-Workon-Timestamp',
  signature: 'X-Workon-Signature',
  idempotency: 'Idempotency-Key',
} as const;
export const OUTBOUND_EVENT = 'app.run.completed';

export type OutboundStatus = 'pending' | 'sending' | 'sent' | 'gave_up';
export const OUTBOUND_STATUS_LABELS: Record<OutboundStatus, string> = {
  pending: '보낼 차례 기다림', sending: '보내는 중', sent: '보냄', gave_up: '그만둠',
};

export interface OutboundEndpointView {
  id: string;
  name: string;
  /** 화면에는 주소 전체를 보인다(관리자 화면만 — 직원 화면에는 이름만) */
  url: string;
  secretPrefix: string;
  createdAt: string;
  createdByName: string | null;
  revokedAt: string | null;
  revokedReason: string | null;
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

export function parseCreateEndpoint(raw: unknown): { ok: true; value: { name: string; url: string } } | { ok: false; message: string } {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { ok: false, message: '보낼 곳 정보를 확인해 주세요.' };
  const body = raw as Record<string, unknown>;
  const name = typeof body.name === 'string' ? body.name.trim().replace(/\s+/g, ' ') : '';
  if (!name || name.length > OUTBOUND_NAME_MAX || CONTROL.test(name)) return { ok: false, message: `이름은 ${OUTBOUND_NAME_MAX}자 안으로 입력해 주세요.` };
  const url = parseOutboundUrl(body.url);
  if (!url.ok) return url;
  return { ok: true, value: { name, url: url.url } };
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

export type AttemptOutcome =
  | { kind: 'sent'; status: number }
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

/** 보내는 몸 — 결과 글(상한에서 자름)과 앱·실행 식별자만. 입력값·중간 단계·직원 정보는 싣지 않는다 */
export function buildOutboundPayload(input: {
  deliveryId: string; sentAt: string;
  app: { id: string; name: string };
  run: { messageId: string; conversationId: string; completedAt: string };
  text: string;
}): string {
  const truncated = input.text.length > OUTBOUND_TEXT_MAX;
  return JSON.stringify({
    event: OUTBOUND_EVENT,
    delivery_id: input.deliveryId,
    sent_at: input.sentAt,
    app: { id: input.app.id, name: input.app.name },
    run: { message_id: input.run.messageId, conversation_id: input.run.conversationId, completed_at: input.run.completedAt },
    result: { text: truncated ? input.text.slice(0, OUTBOUND_TEXT_MAX) : input.text, truncated },
  });
}

/** 받는 쪽 확인 방법 — 안내 글(화면·문서 공용) */
export const OUTBOUND_VERIFY_HINT = `받는 쪽은 ${OUTBOUND_HEADERS.signature} 머리글이 sha256=HMAC-SHA256(비밀값, "{${OUTBOUND_HEADERS.timestamp}}." + 받은 본문 그대로)의 16진수와 같은지, 시각이 5분 안인지 보세요. 같은 ${OUTBOUND_HEADERS.delivery}(${OUTBOUND_HEADERS.idempotency})가 다시 오면 한 번만 처리하세요.`;
