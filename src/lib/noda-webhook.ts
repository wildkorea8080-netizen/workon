// src/lib/noda-webhook.ts
import { createHmac, timingSafeEqual } from 'crypto';
import { logSystem } from '@/lib/logger';
import { agentIdFromNodaTenant, documentIdFromNodaFilename } from '@/lib/noda';
import { orgTypeFromCommonTenant } from '@/lib/org-types';
import { commonReadingDeps } from '@/lib/common-documents';
import {
  defaultReadingDeps,
  nodaFailurePatch,
  runAfterReady,
  unreadableReason,
  type FinishPatch,
  type ReadingDeps,
} from '@/lib/document-reading';

/**
 * NODA 웹훅(2026-10-24) — 읽기 결과(`document.ready`·`document.unreadable`·`document.failed`)를 받아
 * 목록을 아무도 열지 않아도 행을 바꾼다. 나만의 비서·부서 비서 문서가 관리자 목록에 안 보여 '읽는 중'에 남던 공백을 메운다.
 *
 * - 키 하나(`workon`)에 웹훅 하나 — `workon-…` 보관함 전체의 알림이 오고 `tenant`로 비서(`workon-a…`)와 공통 자료실(`workon-c-…`)을 가른다
 * - **알림이지 장부가 아니다**(NODA) — 놓친 알림은 문서 목록 맞추기(`reconcileReading`)가 바로잡는다
 * - 같은 `delivery`가 다시 와도 해가 없다: 행은 `reading`일 때만 바뀐다(조건부 갱신)
 */

/** 서명 시각이 이보다 멀면 버린다 — 되풀이 막기 */
export const WEBHOOK_MAX_AGE_MS = 5 * 60_000;

function parseTimestamp(ts: string): number | null {
  if (/^\d+$/.test(ts)) {
    const n = Number(ts);
    // 초인지 밀리초인지는 크기로 가린다
    return n > 1e12 ? n : n * 1000;
  }
  const t = Date.parse(ts);
  return Number.isFinite(t) ? t : null;
}

/**
 * `X-NODA-Signature: sha256=<hex>` = HMAC-SHA256(secret, "{timestamp}." + 본문 바이트).
 * 본문은 받은 글 그대로여야 한다(다시 직렬화하면 서명이 어긋난다). 던지지 않는다
 */
export function verifyNodaSignature(input: {
  rawBody: string;
  timestamp: string | null;
  signature: string | null;
  secret: string;
  now: number;
}): { ok: true } | { ok: false; reason: 'missing' | 'stale' | 'bad_signature' } {
  const { rawBody, timestamp, signature, secret, now } = input;
  if (!timestamp || !signature) return { ok: false, reason: 'missing' };
  const at = parseTimestamp(timestamp);
  if (at === null || Math.abs(now - at) > WEBHOOK_MAX_AGE_MS) return { ok: false, reason: 'stale' };
  const m = /^sha256=([0-9a-f]{64})$/i.exec(signature.trim());
  if (!m) return { ok: false, reason: 'bad_signature' };
  const expected = createHmac('sha256', secret).update(`${timestamp}.${rawBody}`).digest();
  const given = Buffer.from(m[1], 'hex');
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return { ok: false, reason: 'bad_signature' };
  return { ok: true };
}

export type WebhookOutcome = 'updated' | 'unchanged' | 'ignored' | 'mismatch' | 'orphan' | 'logged';

/** 시험용으로 갈아 끼우는 의존 — 비서 보관함(`documents`)과 공통 보관함(`common_documents`)이 따로다 */
export interface WebhookDeps {
  agent?: ReadingDeps;
  common?: ReadingDeps;
  /** 운영 기록(한도 경고). 기본은 logSystem */
  log?: typeof logSystem;
}

const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);

/**
 * `quota.warning` — 서비스 한도(용량 `bytes`·문서 수 `documents`)의 80%·95%를 넘는 순간 한 번씩 온다.
 * 넘으면 새 문서 넣기가 403으로 막히므로 운영자가 미리 보게 남긴다: 95% 이상은 critical, 그 밖은 warning.
 * 지금 값은 언제든 NODA `GET /tenants`·`/usage`의 `quota`가 참이다(서버가 다시 뜨면 같은 문턱이 한 번 더 올 수 있다)
 */
async function logQuotaWarning(event: Record<string, unknown>, log: typeof logSystem): Promise<void> {
  const level = num(event.level);
  await log({
    level: level !== null && level >= 95 ? 'critical' : 'warning',
    category: 'api',
    message: 'NODA 문서 보관 한도에 가까워짐 — 넘으면 새 문서를 읽지 못합니다',
    details: {
      kind: event.kind === 'bytes' || event.kind === 'documents' ? event.kind : null,
      level,
      used: num(event.used),
      max: num(event.max),
      remaining: num(event.remaining),
      ...(typeof event.event_id === 'string' ? { event_id: event.event_id } : {}),
    },
  });
}

/**
 * 알림 하나를 행에 쓴다. `tenant`로 먼저 가른다 — 비서 보관함이면 `documents`, 공통 보관함이면 `common_documents`.
 * 보관함과 NODA 파일 이름이 **그 행과 정확히 맞을 때만** 바꾼다(비서는 `agent_id`, 공통은 `org_type`) —
 * 다른 비서·다른 유형의 행은 건드리지 않는다. 운영 기록에는 파일 이름을 남기지 않는다(문서 id·종류만).
 * `ready`를 쓴 뒤에는 `afterReady`를 부른다(공통 문서가 옛 판을 내리는 자리 — 실패는 기록만).
 */
export async function applyNodaEvent(
  event: Record<string, unknown>,
  deps: WebhookDeps = {},
): Promise<WebhookOutcome> {
  const kind = typeof event.event === 'string' ? event.event : '';
  if (kind === 'quota.warning') {
    await logQuotaWarning(event, deps.log ?? logSystem);
    return 'logged';
  }
  if (kind !== 'document.ready' && kind !== 'document.unreadable' && kind !== 'document.failed') return 'ignored';

  const tenant = typeof event.tenant === 'string' ? event.tenant : '';
  const filename = typeof event.filename === 'string' ? event.filename : '';
  const agentId = agentIdFromNodaTenant(tenant);
  const orgType = agentId ? null : orgTypeFromCommonTenant(tenant);
  const documentId = documentIdFromNodaFilename(filename);
  // 비서·공통 보관함이 아닌 곳(`workon`·점검용 `workon-check`)이나 WORKON이 붙이지 않은 이름은 우리 행이 아니다
  if ((!agentId && !orgType) || !documentId) return 'ignored';

  const d = agentId ? (deps.agent ?? defaultReadingDeps()) : (deps.common ?? commonReadingDeps());
  const matches = (row: { agent_id?: string | null; org_type?: string | null }) =>
    agentId ? row.agent_id === agentId : row.org_type === orgType;

  const row = await d.store.getRow(documentId);
  if (!row) {
    // 읽는 도중 문서가 지워졌다 — NODA에 생긴 사본을 그 보관함에서 지운다(실패는 기록만)
    if (kind === 'document.failed') return 'ignored';
    try {
      await d.noda.deleteDocument(tenant, filename);
    } catch {
      await d.log({
        level: 'warning',
        category: 'api',
        message: 'NODA 웹훅 — 지워진 문서의 사본을 지우지 못함',
        details: { document_id: documentId, event: kind },
      });
    }
    return 'orphan';
  }
  if (!matches(row) || row.noda_filename !== filename) {
    await d.log({
      level: 'warning',
      category: 'security',
      message: 'NODA 웹훅 — 보관함·파일 이름이 문서 행과 맞지 않음',
      details: { document_id: documentId, event: kind },
    });
    return 'mismatch';
  }

  let patch: FinishPatch | null;
  if (kind === 'document.ready') {
    patch = {
      noda_status: 'ready',
      noda_reason: null,
      ...(typeof event.doc_id === 'string' ? { noda_doc_id: event.doc_id } : {}),
      noda_read_at: new Date(d.now()).toISOString(),
    };
  } else if (kind === 'document.unreadable') {
    patch = { noda_status: 'unreadable', noda_reason: unreadableReason(typeof event.reason === 'string' ? event.reason : null) };
  } else {
    patch = nodaFailurePatch(typeof event.status === 'number' ? event.status : null);
  }
  if (!patch) return 'unchanged';
  if (!(await d.store.finish(documentId, patch))) return 'unchanged';
  if (patch.noda_status === 'ready') await runAfterReady(d, documentId);
  return 'updated';
}
