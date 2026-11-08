// src/lib/apps/webhooks.ts
// 입력형 앱 외부 연동(Webhook, 0049) — 알리웍스 Agent Builder의 Webhook 트리거(멤버 토큰)에 대응.
//
// - 직원이 앱마다 연동 토큰을 만든다(`wo_wh_` + 32바이트). **원문은 만든 응답에서 한 번만** 보이고 DB에는 SHA-256만 남는다.
//   유효 기간은 30·90·365일 중 하나(무기한 없음), 직원이 언제든 회수한다. 한 사람이 쓸 수 있는 연동은 5개.
// - 외부 시스템이 `POST /api/apps/webhook`(`Authorization: Bearer 토큰`, 본문 `{ inputs }`)을 부르면 그 직원의 권한으로 앱을 한 번 실행한다
//   (`run-as.ts` — 손 실행과 같은 권한·한도·사용 기록·대화 저장). 결과 대화는 그 직원의 앱 실행 기록에 `[연동]` 제목으로 남는다.
// - **응답에는 앱의 결과 글을 싣지 않는다** — 상태와 대화 id만. 결과가 기관 밖 시스템으로 나가지 않게(보안성 검토에서 데이터 흐름을 늘리지 않는다).
// - 같은 토큰은 60초에 한 번·하루 100번까지(`app_webhook_claim`이 행 잠금으로 원자적으로 본다). 재시도·동시 호출이 겹쳐도 한 번만 돈다.
// - 무효 토큰(없음·회수·만료)은 모두 같은 401 — 어느 토큰이 있었는지 밖에 가르지 않는다.
// - `Idempotency-Key` 머리글(0051)이 있으면 같은 연동·같은 키의 호출은 24시간 동안 앱을 다시 돌리지 않고 처음 응답(상태·대화 id·안내)을 돌려준다
//   (`Idempotent-Replayed: true`). 같은 키로 다른 입력이면 422, 처음 호출이 아직 돌면 409. 다시 보내기는 간격·하루 상한·사용 횟수를 쓰지 않는다.
//   지나가는 실패(5xx·기관 한도 429)는 기록하지 않아 같은 키로 다시 시도할 수 있다.
// - 기관 전체 관리자가 외부 연동을 끄면(0068, `webhook-switch.ts`) 호출은 차지 전에 403 — 토큰은 그대로라 다시 켜면 쓴다.
// - 문서함에서 고른 문서(0063)는 연동에 저장하고 호출마다 지금 근거 판으로 읽는다(`executeWebhook` — 예약과 같은 `currentEditionIds`).
//   쓸 판이 없으면 422로 거절한다(문서 없이 돌지 않는다). 외부 시스템은 문서를 고르지 않는다.
import { createHash, randomBytes } from 'crypto';
import { supabaseAdmin } from '@/lib/supabaseAdmin';
import { logSystem } from '@/lib/logger';
import { defaultRunAsIo, runAppAs, type RunAsInput, type RunAsOutcome } from './run-as';
import { currentEditionIds, type LibraryDocumentRow } from './library-documents';
import { agentDocumentRows } from './app-document-choice';
import {
  WEBHOOK_DAILY_LIMIT, WEBHOOK_MAX_BODY_BYTES, WEBHOOK_MIN_INTERVAL_SECONDS, WEBHOOK_SHOWN_PREFIX_CHARS, WEBHOOK_TITLE_PREFIX, WEBHOOK_TOKEN_PREFIX,
  IDEMPOTENCY_HEADER, WEBHOOK_ORG_DISABLED, bearerWebhookToken, canonicalInputs, parseIdempotencyKey,
} from './webhook-spec';
import { tokenOrgWebhooksDisabled } from './webhook-switch';

export function hashWebhookToken(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

export function generateWebhookToken(): { token: string; hash: string; prefix: string } {
  const token = `${WEBHOOK_TOKEN_PREFIX}${randomBytes(32).toString('base64url')}`;
  return { token, hash: hashWebhookToken(token), prefix: token.slice(0, WEBHOOK_SHOWN_PREFIX_CHARS) };
}

export type ClaimedWebhook = { id: string; agent_id: string; user_id: string; department_id: string; organization_id: string; app_version: number };
export type ReplayedCall = { http_status: number; conversation_id: string | null; message: string | null };
export type ClaimResult =
  | { ok: true; webhook: ClaimedWebhook; call_id?: string | null }
  | { ok: false; reason: 'invalid' | 'daily_limit' | 'key_mismatch' | 'in_progress' }
  | { ok: false; reason: 'too_soon'; retry_after: number }
  | { ok: false; reason: 'replay'; call: ReplayedCall };
export type CallRecord = { http_status: number; conversation_id: string | null; message: string | null };

export interface WebhookDeps {
  /**
   * 이 토큰의 기관이 외부 연동을 꺼 두었는가(0068) — 차지 **전에** 본다(꺼진 동안의 호출이 간격·하루 상한·사용 횟수를 쓰지 않게).
   * 쓸 수 있는 토큰(활성·안 만료)만 보고, 그 밖은 거짓(차지가 401로 거절한다 — 무효 토큰에 기관 상태를 알리지 않는다). 읽지 못하면 던진다(닫힘)
   */
  orgDisabled(tokenHash: string, nowMs: number): Promise<boolean>;
  claim(tokenHash: string, nowMs: number, idempotency?: { key: string; requestHash: string }): Promise<ClaimResult>;
  /** 키 있는 호출의 결과를 남긴다(null이면 지워 같은 키로 다시 시도할 수 있게 — 서버 쪽 실패) */
  recordCall(callId: string, record: CallRecord | null): Promise<void>;
  execute(webhook: ClaimedWebhook, inputs: Record<string, string>): Promise<RunAsOutcome>;
  finish(id: string, patch: { last_status: 'completed' | 'failed'; last_error: string | null; last_conversation_id: string | null; updated_at: string }): Promise<void>;
  log(level: 'info' | 'warning' | 'error', message: string, details: Record<string, unknown>, organizationId: string | null): Promise<void>;
  now(): number;
}

export type WebhookResponse = { status: number; body: Record<string, unknown>; headers?: Record<string, string> };

export const WEBHOOK_INVALID_TOKEN = '연동 토큰이 올바르지 않거나 회수·만료됐습니다.';
export const WEBHOOK_APP_CHANGED = '앱 설정이 바뀌어 이 연동으로 실행할 수 없습니다. 앱 화면에서 연동을 다시 만들어 주세요.';
export const WEBHOOK_USER_UNAVAILABLE = '연동을 만든 직원의 계정을 쓸 수 없습니다.';
export const WEBHOOK_KEY_MISMATCH = `같은 ${IDEMPOTENCY_HEADER}로 다른 입력을 보냈습니다. 요청마다 새 키를 쓰세요.`;
export const WEBHOOK_IN_PROGRESS = `같은 ${IDEMPOTENCY_HEADER} 요청을 아직 처리하고 있습니다. 잠시 뒤 같은 키로 다시 보내면 결과를 돌려받습니다.`;
export const REPLAYED_HEADER = 'Idempotent-Replayed';
export const WEBHOOK_DEPARTMENT_CHANGED = '연동을 만든 직원의 소속 부서가 바뀌었습니다. 연동을 다시 만들어 주세요.';
export const WEBHOOK_DOCUMENTS_UNAVAILABLE = '연동에 고른 문서를 더 쓸 수 없습니다(지움·읽기 실패·지난 판). 앱 화면에서 문서를 다시 골라 연동을 새로 만들어 주세요.';

export interface ExecuteWebhookIo {
  /** 연동에 저장한 문서 id */
  documentIdsOf(webhookId: string): Promise<string[]>;
  documentsOf(agentId: string, organizationId: string): Promise<LibraryDocumentRow[]>;
  /** 새 판으로 따라갔으면 다음 호출부터 그 id로 */
  saveDocumentIds(webhookId: string, ids: string[]): Promise<void>;
  run(input: RunAsInput): Promise<RunAsOutcome>;
}

/** 연동 한 번 실행 — 고른 문서를 지금 근거 판으로 맞춰 그 직원으로 앱을 돌린다. 쓸 판이 없으면 앱을 돌리지 않고 422 */
export async function executeWebhook(w: ClaimedWebhook, inputs: Record<string, string>, io: ExecuteWebhookIo): Promise<RunAsOutcome> {
  const stored = await io.documentIdsOf(w.id);
  let documentIds: string[] | undefined;
  let followed = false;
  if (stored.length) {
    const resolved = currentEditionIds(stored, await io.documentsOf(w.agent_id, w.organization_id), w.agent_id);
    if (!resolved.ok) return { kind: 'rejected', status: 422, message: WEBHOOK_DOCUMENTS_UNAVAILABLE };
    documentIds = resolved.ids;
    followed = resolved.changed;
  }
  const outcome = await io.run({ userId: w.user_id, departmentId: w.department_id, agentId: w.agent_id, appVersion: w.app_version, inputs, documentIds });
  if (outcome.kind === 'completed' && followed && documentIds) {
    try { await io.saveDocumentIds(w.id, documentIds); } catch { /* 다음 호출이 다시 따라간다 */ }
  }
  return outcome;
}

const fail = (status: number, message: string, headers?: Record<string, string>): WebhookResponse => ({ status, body: { ok: false, error: { message } }, headers });
const errorText = (error: unknown) => (error instanceof Error ? error.message.slice(0, 200) : 'unknown');

/** 입력은 글·숫자·참거짓만 받아 글로 바꾼다(앱 폼 값은 모두 글이다). 그 밖의 꼴은 거절 — 검사(필수·형식·길이)는 실행기가 앱 판으로 다시 한다 */
function readInputs(raw: unknown): Record<string, string> | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof value === 'string') out[key] = value;
    else if (typeof value === 'number' && Number.isFinite(value)) out[key] = String(value);
    else if (typeof value === 'boolean') out[key] = String(value);
    else if (value === null) out[key] = '';
    else return null;
  }
  return out;
}

/** 호출 하나 처리 — 토큰 꼴 → 본문 → 차지(간격·하루 상한) → 실행 → 기록. 앱 결과 글은 응답에 싣지 않는다 */
export async function handleWebhookCall(deps: WebhookDeps, request: { authorization: string | null; bodyText: string; idempotencyKey?: string | null }): Promise<WebhookResponse> {
  const token = bearerWebhookToken(request.authorization);
  if (!token) return fail(401, WEBHOOK_INVALID_TOKEN);
  const idem = parseIdempotencyKey(request.idempotencyKey ?? null);
  if (!idem.ok) return fail(400, idem.message);
  if (Buffer.byteLength(request.bodyText, 'utf8') > WEBHOOK_MAX_BODY_BYTES) return fail(413, '보내는 내용이 너무 큽니다(64KB까지).');
  let parsed: unknown;
  try { parsed = request.bodyText ? JSON.parse(request.bodyText) : {}; } catch { return fail(400, '본문은 JSON이어야 합니다 — { "inputs": { "항목 키": "값" } }'); }
  const inputs = readInputs((parsed as { inputs?: unknown } | null)?.inputs ?? {});
  if (!inputs) return fail(400, 'inputs는 항목 키와 글·숫자 값의 객체여야 합니다.');

  if (await deps.orgDisabled(hashWebhookToken(token), deps.now())) return fail(403, WEBHOOK_ORG_DISABLED);
  const idempotency = idem.key ? { key: idem.key, requestHash: createHash('sha256').update(canonicalInputs(inputs), 'utf8').digest('hex') } : undefined;
  const claim = await deps.claim(hashWebhookToken(token), deps.now(), idempotency);
  if (!claim.ok) {
    if (claim.reason === 'replay') return replayResponse(claim.call);
    if (claim.reason === 'key_mismatch') return fail(422, WEBHOOK_KEY_MISMATCH);
    if (claim.reason === 'in_progress') return fail(409, WEBHOOK_IN_PROGRESS, { 'Retry-After': '30' });
    if (claim.reason === 'too_soon') return fail(429, `같은 연동은 ${WEBHOOK_MIN_INTERVAL_SECONDS}초에 한 번만 실행합니다. ${claim.retry_after}초 뒤 다시 보내 주세요.`, { 'Retry-After': String(claim.retry_after) });
    if (claim.reason === 'daily_limit') return fail(429, `이 연동은 하루 ${WEBHOOK_DAILY_LIMIT}번까지 실행합니다. 내일 다시 보내 주세요.`);
    return fail(401, WEBHOOK_INVALID_TOKEN);
  }
  const webhook = claim.webhook;

  let outcome: RunAsOutcome;
  try { outcome = await deps.execute(webhook, inputs); }
  catch (error) { outcome = { kind: 'failed', error: '실행 중 오류가 났습니다.', conversationId: null }; await deps.log('error', '앱 연동 실행 오류', { webhook_id: webhook.id, error: errorText(error) }, webhook.organization_id); }

  let response: WebhookResponse;
  switch (outcome.kind) {
    case 'completed': response = { status: 200, body: { ok: true, data: { status: 'completed', conversation_id: outcome.conversationId } } }; break;
    case 'user_unavailable': response = fail(403, WEBHOOK_USER_UNAVAILABLE); break;
    case 'department_changed': response = fail(403, WEBHOOK_DEPARTMENT_CHANGED); break;
    case 'rejected': response = fail(outcome.status, outcome.status === 409 ? WEBHOOK_APP_CHANGED : outcome.message); break;
    case 'failed': response = fail(502, outcome.error); break;
  }
  const failed = outcome.kind !== 'completed';
  const message = failed ? String((response.body.error as { message: string }).message).slice(0, 300) : null;
  try {
    await deps.finish(webhook.id, {
      last_status: failed ? 'failed' : 'completed', last_error: message,
      last_conversation_id: outcome.kind === 'completed' || outcome.kind === 'failed' ? outcome.conversationId : null,
      updated_at: new Date(deps.now()).toISOString(),
    });
  } catch (error) { await deps.log('warning', '앱 연동 실행 결과를 저장하지 못함', { webhook_id: webhook.id, error: errorText(error) }, webhook.organization_id); }
  if (claim.call_id) {
    // 지나가는 실패(5xx·기관 한도 429)는 남기지 않는다 — 같은 키로 다시 시도하면 새로 돈다. 그 밖(완료·4xx)은 같은 키에 같은 응답을 돌려준다
    const record: CallRecord | null = response.status >= 500 || response.status === 429 ? null : {
      http_status: response.status, message,
      conversation_id: outcome.kind === 'completed' ? outcome.conversationId : null,
    };
    try { await deps.recordCall(claim.call_id, record); }
    catch (error) { await deps.log('warning', '앱 연동 호출 기록을 저장하지 못함', { webhook_id: webhook.id, error: errorText(error) }, webhook.organization_id); }
  }
  // 입력값·결과 글은 남기지 않는다 — 연동 id·앱·상태만
  if (failed) await deps.log('warning', '앱 연동 실행 실패', { webhook_id: webhook.id, agent_id: webhook.agent_id, status: response.status, kind: outcome.kind }, webhook.organization_id);
  return response;
}

/** 같은 키의 처음 응답을 그대로 — 완료면 상태·대화 id, 거절이면 그 상태·안내 */
function replayResponse(call: ReplayedCall): WebhookResponse {
  const headers = { [REPLAYED_HEADER]: 'true' };
  if (call.http_status === 200) return { status: 200, body: { ok: true, data: { status: 'completed', conversation_id: call.conversation_id, replayed: true } }, headers };
  return fail(call.http_status, call.message ?? '처음 요청이 거절됐습니다.', headers);
}

export function webhookDeps(): WebhookDeps {
  return {
    orgDisabled: tokenOrgWebhooksDisabled,
    async claim(tokenHash, nowMs, idempotency) {
      const { data, error } = await supabaseAdmin.rpc('app_webhook_claim', {
        p_token_hash: tokenHash, p_now: new Date(nowMs).toISOString(), p_min_interval_seconds: WEBHOOK_MIN_INTERVAL_SECONDS, p_daily_limit: WEBHOOK_DAILY_LIMIT,
        p_idempotency_key: idempotency?.key ?? null, p_request_hash: idempotency?.requestHash ?? null,
      });
      if (error) throw new Error(`app_webhook_claim: ${error.message}`);
      return data as ClaimResult;
    },
    execute: (w, inputs) => executeWebhook(w, inputs, {
      async documentIdsOf(id) {
        const { data, error } = await supabaseAdmin.from('app_webhooks').select('document_ids').eq('id', id).maybeSingle();
        if (error) throw new Error(`app_webhooks documents: ${error.message}`);
        return ((data as { document_ids?: string[] | null } | null)?.document_ids ?? []);
      },
      documentsOf: agentDocumentRows,
      async saveDocumentIds(id, ids) {
        const { error } = await supabaseAdmin.from('app_webhooks').update({ document_ids: ids }).eq('id', id);
        if (error) throw new Error(`app_webhooks documents save: ${error.message}`);
      },
      run: (input) => runAppAs(input, WEBHOOK_TITLE_PREFIX, defaultRunAsIo()),
    }),
    async finish(id, patch) {
      const { error } = await supabaseAdmin.from('app_webhooks').update(patch).eq('id', id);
      if (error) throw new Error(`app_webhooks finish: ${error.message}`);
    },
    async recordCall(callId, record) {
      const { error } = record
        ? await supabaseAdmin.from('app_webhook_calls').update({ status: 'done', ...record, updated_at: new Date().toISOString() }).eq('id', callId)
        : await supabaseAdmin.from('app_webhook_calls').delete().eq('id', callId);
      if (error) throw new Error(`app_webhook_calls: ${error.message}`);
    },
    log: (level, message, details, organizationId) => logSystem({ level, category: 'api', message, details, orgId: organizationId }),
    now: () => Date.now(),
  };
}
