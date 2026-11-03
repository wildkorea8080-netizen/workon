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
import { createHash, randomBytes } from 'crypto';
import { supabaseAdmin } from '@/lib/supabaseAdmin';
import { logSystem } from '@/lib/logger';
import { defaultRunAsIo, runAppAs, type RunAsOutcome } from './run-as';
import {
  WEBHOOK_DAILY_LIMIT, WEBHOOK_MAX_BODY_BYTES, WEBHOOK_MIN_INTERVAL_SECONDS, WEBHOOK_SHOWN_PREFIX_CHARS, WEBHOOK_TITLE_PREFIX, WEBHOOK_TOKEN_PREFIX,
  bearerWebhookToken,
} from './webhook-spec';

export function hashWebhookToken(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

export function generateWebhookToken(): { token: string; hash: string; prefix: string } {
  const token = `${WEBHOOK_TOKEN_PREFIX}${randomBytes(32).toString('base64url')}`;
  return { token, hash: hashWebhookToken(token), prefix: token.slice(0, WEBHOOK_SHOWN_PREFIX_CHARS) };
}

export type ClaimedWebhook = { id: string; agent_id: string; user_id: string; department_id: string; organization_id: string; app_version: number };
export type ClaimResult =
  | { ok: true; webhook: ClaimedWebhook }
  | { ok: false; reason: 'invalid' | 'daily_limit' }
  | { ok: false; reason: 'too_soon'; retry_after: number };

export interface WebhookDeps {
  claim(tokenHash: string, nowMs: number): Promise<ClaimResult>;
  execute(webhook: ClaimedWebhook, inputs: Record<string, string>): Promise<RunAsOutcome>;
  finish(id: string, patch: { last_status: 'completed' | 'failed'; last_error: string | null; last_conversation_id: string | null; updated_at: string }): Promise<void>;
  log(level: 'info' | 'warning' | 'error', message: string, details: Record<string, unknown>, organizationId: string | null): Promise<void>;
  now(): number;
}

export type WebhookResponse = { status: number; body: Record<string, unknown>; headers?: Record<string, string> };

export const WEBHOOK_INVALID_TOKEN = '연동 토큰이 올바르지 않거나 회수·만료됐습니다.';
export const WEBHOOK_APP_CHANGED = '앱 설정이 바뀌어 이 연동으로 실행할 수 없습니다. 앱 화면에서 연동을 다시 만들어 주세요.';
export const WEBHOOK_USER_UNAVAILABLE = '연동을 만든 직원의 계정을 쓸 수 없습니다.';
export const WEBHOOK_DEPARTMENT_CHANGED = '연동을 만든 직원의 소속 부서가 바뀌었습니다. 연동을 다시 만들어 주세요.';

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
export async function handleWebhookCall(deps: WebhookDeps, request: { authorization: string | null; bodyText: string }): Promise<WebhookResponse> {
  const token = bearerWebhookToken(request.authorization);
  if (!token) return fail(401, WEBHOOK_INVALID_TOKEN);
  if (Buffer.byteLength(request.bodyText, 'utf8') > WEBHOOK_MAX_BODY_BYTES) return fail(413, '보내는 내용이 너무 큽니다(64KB까지).');
  let parsed: unknown;
  try { parsed = request.bodyText ? JSON.parse(request.bodyText) : {}; } catch { return fail(400, '본문은 JSON이어야 합니다 — { "inputs": { "항목 키": "값" } }'); }
  const inputs = readInputs((parsed as { inputs?: unknown } | null)?.inputs ?? {});
  if (!inputs) return fail(400, 'inputs는 항목 키와 글·숫자 값의 객체여야 합니다.');

  const claim = await deps.claim(hashWebhookToken(token), deps.now());
  if (!claim.ok) {
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
  // 입력값·결과 글은 남기지 않는다 — 연동 id·앱·상태만
  if (failed) await deps.log('warning', '앱 연동 실행 실패', { webhook_id: webhook.id, agent_id: webhook.agent_id, status: response.status, kind: outcome.kind }, webhook.organization_id);
  return response;
}

export function webhookDeps(): WebhookDeps {
  return {
    async claim(tokenHash, nowMs) {
      const { data, error } = await supabaseAdmin.rpc('app_webhook_claim', {
        p_token_hash: tokenHash, p_now: new Date(nowMs).toISOString(), p_min_interval_seconds: WEBHOOK_MIN_INTERVAL_SECONDS, p_daily_limit: WEBHOOK_DAILY_LIMIT,
      });
      if (error) throw new Error(`app_webhook_claim: ${error.message}`);
      return data as ClaimResult;
    },
    execute: (w, inputs) => runAppAs({ userId: w.user_id, departmentId: w.department_id, agentId: w.agent_id, appVersion: w.app_version, inputs }, WEBHOOK_TITLE_PREFIX, defaultRunAsIo()),
    async finish(id, patch) {
      const { error } = await supabaseAdmin.from('app_webhooks').update(patch).eq('id', id);
      if (error) throw new Error(`app_webhooks finish: ${error.message}`);
    },
    log: (level, message, details, organizationId) => logSystem({ level, category: 'api', message, details, orgId: organizationId }),
    now: () => Date.now(),
  };
}
