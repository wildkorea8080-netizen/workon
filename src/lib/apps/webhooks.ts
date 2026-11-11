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
// - 외부 시스템은 본문 `files`(`[{ name, content_base64 }]`, 3개·풀어서 3MB까지)로 파일을 함께 보낼 수 있다(2026-11-08). 차지한 뒤
//   그 직원의 새 첨부로 올려(`attachBytes` — 직접 올리기와 같은 형식·크기·읽기·사용 기록) 그 실행의 대화에 붙인다. 읽지 못하면 422.
//   파일 내용은 따로 저장하지 않고(대화 첨부로만 남는다) `Idempotency-Key`의 요청 해시에 이름·SHA-256만 넣는다.
// - **비동기 호출**(2026-11-11, 0087): 본문 `"async": true` 또는 `Prefer: respond-async`면 기다리지 않고 202 `{ status: 'accepted', batch_id }`.
//   그 직원의 한 줄짜리 일괄 실행(`createBatch` — 같은 앱 규칙·권한·기관 상한, 연동이 박은 앱 판, `source='webhook'`)으로 넣어
//   일괄 실행 실행기(5분)가 돌린다(300초 넘는 앱도). 결과는 앱의 '결과 보낼 곳'(0076)이 있으면 그리로 가고 몸의 `run.batch_id`로 맞춘다 —
//   이것이 콜백이다(보낼 곳은 기관 전체 관리자가 승인한 주소만). 파일·문서함 문서를 쓰는 호출은 비동기로 받지 않는다(400). 마침 메일은 보내지 않는다.
import { createHash, randomBytes } from 'crypto';
import { supabaseAdmin } from '@/lib/supabaseAdmin';
import { logSystem } from '@/lib/logger';
import { defaultRunAsIo, runAppAs, type RunAsInput, type RunAsOutcome } from './run-as';
import { currentEditionIds, type LibraryDocumentRow } from './library-documents';
import { agentDocumentRows } from './app-document-choice';
import {
  WEBHOOK_DAILY_LIMIT, WEBHOOK_MAX_BODY_BYTES, WEBHOOK_MAX_BODY_WITH_FILES_BYTES, WEBHOOK_MAX_FILES, WEBHOOK_MAX_FILE_TOTAL_BYTES, WEBHOOK_MIN_INTERVAL_SECONDS, WEBHOOK_SHOWN_PREFIX_CHARS, WEBHOOK_TITLE_PREFIX, WEBHOOK_TOKEN_PREFIX,
  IDEMPOTENCY_HEADER, WEBHOOK_ORG_DISABLED, bearerWebhookToken, canonicalInputs, parseIdempotencyKey,
  WEBHOOK_ASYNC_BUSY, WEBHOOK_ASYNC_NO_DOCUMENTS, WEBHOOK_ASYNC_NO_FILES, wantsAsync,
} from './webhook-spec';
import type { Session } from 'next-auth';
import type { ActorScope } from '@/lib/agent-permissions';
import { BATCH_APP_VERSION_CHANGED } from './batch-spec';
import { tokenOrgWebhooksDisabled } from './webhook-switch';
import { attachBytes } from '@/lib/attachments/reuse';
import { deleteAttachment } from '@/lib/attachments/store';
import { attachmentExtension } from '@/lib/attachments/limits';

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
  execute(webhook: ClaimedWebhook, inputs: Record<string, string>, files: WebhookFile[]): Promise<RunAsOutcome>;
  /** 비동기 호출(0087) — 한 줄짜리 일괄 실행으로 넣는다. 없으면 비동기를 받지 않는다(501) */
  enqueue?(webhook: ClaimedWebhook, inputs: Record<string, string>): Promise<WebhookEnqueueOutcome>;
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

/** 외부 시스템이 보낸 파일 하나(풀어 둔 바이트) */
export type WebhookFile = { name: string; bytes: Buffer };
export const WEBHOOK_FILES_FORMAT = 'files는 [{ "name": "파일 이름.xlsx", "content_base64": "..." }] 꼴이어야 합니다.';
export const WEBHOOK_FILE_UNREADABLE = (name: string, reason: string | null) => `보낸 파일 '${name}'을 읽지 못했습니다${reason ? `(${reason})` : ''}.`;
const BASE64 = /^[A-Za-z0-9+/]*={0,2}$/;

/** 본문의 files 읽기(순수) — 꼴·base64·첨부 형식·개수·합계 크기. 없으면 빈 목록 */
export function parseWebhookFiles(raw: unknown): { ok: true; files: WebhookFile[] } | { ok: false; status: number; message: string } {
  if (raw === undefined || raw === null) return { ok: true, files: [] };
  if (!Array.isArray(raw)) return { ok: false, status: 400, message: WEBHOOK_FILES_FORMAT };
  if (raw.length > WEBHOOK_MAX_FILES) return { ok: false, status: 400, message: `파일은 한 번에 ${WEBHOOK_MAX_FILES}개까지 보낼 수 있습니다.` };
  const files: WebhookFile[] = [];
  let total = 0;
  for (const item of raw) {
    const { name, content_base64: content } = (item && typeof item === 'object' ? item : {}) as Record<string, unknown>;
    if (typeof name !== 'string' || !name.trim() || name.length > 200 || typeof content !== 'string' || content.length % 4 !== 0 || !BASE64.test(content)) {
      return { ok: false, status: 400, message: WEBHOOK_FILES_FORMAT };
    }
    if (!attachmentExtension(name)) return { ok: false, status: 400, message: `보낼 수 없는 파일 형식입니다: ${name.slice(0, 80)}` };
    const bytes = Buffer.from(content, 'base64');
    if (!bytes.length) return { ok: false, status: 400, message: `빈 파일은 보낼 수 없습니다: ${name.slice(0, 80)}` };
    total += bytes.length;
    if (total > WEBHOOK_MAX_FILE_TOTAL_BYTES) return { ok: false, status: 413, message: '보내는 파일이 너무 큽니다(합계 3MB까지).' };
    files.push({ name, bytes });
  }
  return { ok: true, files };
}

export interface WebhookFileIo {
  attach(actor: { userId: string; departmentId: string; organizationId: string }, file: WebhookFile): ReturnType<typeof attachBytes>;
  discard(userId: string, attachmentId: string): Promise<unknown>;
}
const defaultWebhookFileIo: WebhookFileIo = {
  attach: (actor, file) => attachBytes(actor, file.name, file.bytes),
  discard: (userId, id) => deleteAttachment(userId, id),
};

/** 보낸 파일마다 그 직원의 새 첨부를 올린다. 하나라도 못 하면 만든 첨부를 묘비로 지우고 거절(읽지 못함 422, 그 밖은 발급 상태 그대로) */
async function attachWebhookFiles(
  actor: { userId: string; departmentId: string; organizationId: string }, files: WebhookFile[], io: WebhookFileIo
): Promise<{ ok: true; ids: string[] } | { ok: false; status: number; message: string }> {
  const ids: string[] = [];
  for (const file of files) {
    let failure: { status: number; message: string } | null = null;
    try {
      const result = await io.attach(actor, file);
      if (!result.ok) failure = { status: result.status, message: result.message };
      else {
        ids.push(result.attachment.id);
        if (result.attachment.status !== 'ready') failure = { status: 422, message: WEBHOOK_FILE_UNREADABLE(file.name.slice(0, 80), result.attachment.error) };
      }
    } catch {
      failure = { status: 500, message: '보낸 파일을 올리지 못했습니다. 잠시 뒤 다시 보내 주세요.' };
    }
    if (failure) {
      await discardAll(actor.userId, ids, io);
      return { ok: false, ...failure };
    }
  }
  return { ok: true, ids };
}

export type WebhookEnqueueOutcome =
  | { kind: 'accepted'; batchId: string; resultDelivery: boolean }
  | { kind: 'user_unavailable' } | { kind: 'department_changed' } | { kind: 'app_changed' }
  | { kind: 'rejected'; status: number; message: string };

export interface EnqueueWebhookIo {
  documentIdsOf(webhookId: string): Promise<string[]>;
  loadUser(userId: string): Promise<{ id: string; role: string | null; department_id: string | null; is_active: boolean | null; deleted_at: string | null } | null>;
  actorFor(user: { id: string; role: string | null; department_id: string }): Promise<ActorScope | null>;
  /** 앱의 지금 이름·결과 보낼 곳 유무 */
  appInfo(agentId: string): Promise<{ name: string; deliverEndpointId: string | null } | null>;
  createBatch(actor: ActorScope, body: { agent_id: string; name: string; rows: Record<string, string>[] }, opts: { source: 'webhook'; appVersion: number; webhookId: string }): Promise<{ ok: true; batchId: string } | { ok: false; status: number; message: string }>;
}

/**
 * 비동기 연동 한 번 넣기(0087) — 기다리는 호출(`runAppAs`)과 같은 문턱(계정·부서·앱 판)을 먼저 보고, 그 직원의 한 줄 일괄 실행으로 넣는다.
 * 실행 자체(권한·한도·사용 기록)는 일괄 실행 실행기가 손 실행과 같은 길로 다시 본다
 */
export async function enqueueWebhookRun(w: ClaimedWebhook, inputs: Record<string, string>, io: EnqueueWebhookIo): Promise<WebhookEnqueueOutcome> {
  if ((await io.documentIdsOf(w.id)).length) return { kind: 'rejected', status: 400, message: WEBHOOK_ASYNC_NO_DOCUMENTS };
  const user = await io.loadUser(w.user_id);
  if (!user || user.is_active === false || user.deleted_at) return { kind: 'user_unavailable' };
  if (!user.department_id || user.department_id !== w.department_id) return { kind: 'department_changed' };
  const actor = await io.actorFor({ id: user.id, role: user.role, department_id: user.department_id });
  if (!actor?.organizationId || actor.organizationId !== w.organization_id) return { kind: 'department_changed' };
  const app = await io.appInfo(w.agent_id);
  if (!app) return { kind: 'rejected', status: 404, message: '앱을 찾을 수 없습니다.' };
  const created = await io.createBatch(actor, { agent_id: w.agent_id, name: `${WEBHOOK_TITLE_PREFIX}${app.name}`.slice(0, 80), rows: [inputs] }, { source: 'webhook', appVersion: w.app_version, webhookId: w.id });
  if (created.ok) return { kind: 'accepted', batchId: created.batchId, resultDelivery: Boolean(app.deliverEndpointId) };
  if (created.status === 409 && created.message === BATCH_APP_VERSION_CHANGED) return { kind: 'app_changed' };
  if (created.status === 409) return { kind: 'rejected', status: 429, message: WEBHOOK_ASYNC_BUSY };
  return { kind: 'rejected', status: created.status, message: created.message };
}

/** 대화에 묶이지 못한 첨부를 묘비로(묶인 것은 `deleteAttachment`가 건드리지 않는다) */
async function discardAll(userId: string, ids: string[], io: WebhookFileIo): Promise<void> {
  for (const id of ids) { try { await io.discard(userId, id); } catch { /* 24시간 정리가 치운다 */ } }
}

export interface ExecuteWebhookIo {
  /** 연동에 저장한 문서 id */
  documentIdsOf(webhookId: string): Promise<string[]>;
  documentsOf(agentId: string, organizationId: string): Promise<LibraryDocumentRow[]>;
  /** 새 판으로 따라갔으면 다음 호출부터 그 id로 */
  saveDocumentIds(webhookId: string, ids: string[]): Promise<void>;
  run(input: RunAsInput): Promise<RunAsOutcome>;
  /** 보낸 파일 올리기·지우기 — 시험이 바꿔 끼운다 */
  files?: WebhookFileIo;
}

/**
 * 연동 한 번 실행 — 고른 문서를 지금 근거 판으로 맞추고, 보낸 파일을 새 첨부로 올려 그 직원으로 앱을 돌린다.
 * 쓸 판이 없거나 파일을 읽지 못하면 앱을 돌리지 않고 422. 실행이 시작 전에 거절되면 올린 첨부를 묘비로 지운다
 */
export async function executeWebhook(w: ClaimedWebhook, inputs: Record<string, string>, io: ExecuteWebhookIo, files: WebhookFile[] = []): Promise<RunAsOutcome> {
  const stored = await io.documentIdsOf(w.id);
  let documentIds: string[] | undefined;
  let followed = false;
  if (stored.length) {
    const resolved = currentEditionIds(stored, await io.documentsOf(w.agent_id, w.organization_id), w.agent_id);
    if (!resolved.ok) return { kind: 'rejected', status: 422, message: WEBHOOK_DOCUMENTS_UNAVAILABLE };
    documentIds = resolved.ids;
    followed = resolved.changed;
  }
  const fileIo = io.files ?? defaultWebhookFileIo;
  let attachmentIds: string[] | undefined;
  if (files.length) {
    const attached = await attachWebhookFiles({ userId: w.user_id, departmentId: w.department_id, organizationId: w.organization_id }, files, fileIo);
    if (!attached.ok) return { kind: 'rejected', status: attached.status, message: attached.message };
    attachmentIds = attached.ids;
  }
  const outcome = await io.run({ userId: w.user_id, departmentId: w.department_id, agentId: w.agent_id, appVersion: w.app_version, inputs, documentIds, ...(attachmentIds ? { attachmentIds } : {}) });
  if (attachmentIds && outcome.kind !== 'completed' && outcome.kind !== 'failed') await discardAll(w.user_id, attachmentIds, fileIo);
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
export async function handleWebhookCall(deps: WebhookDeps, request: { authorization: string | null; bodyText: string; idempotencyKey?: string | null; prefer?: string | null }): Promise<WebhookResponse> {
  const token = bearerWebhookToken(request.authorization);
  if (!token) return fail(401, WEBHOOK_INVALID_TOKEN);
  const idem = parseIdempotencyKey(request.idempotencyKey ?? null);
  if (!idem.ok) return fail(400, idem.message);
  const bodyBytes = Buffer.byteLength(request.bodyText, 'utf8');
  if (bodyBytes > WEBHOOK_MAX_BODY_WITH_FILES_BYTES) return fail(413, '보내는 내용이 너무 큽니다(파일 합계 3MB·입력 64KB까지).');
  let parsed: unknown;
  try { parsed = request.bodyText ? JSON.parse(request.bodyText) : {}; } catch { return fail(400, '본문은 JSON이어야 합니다 — { "inputs": { "항목 키": "값" } }'); }
  const rawInputs = (parsed as { inputs?: unknown } | null)?.inputs ?? {};
  const parsedFiles = parseWebhookFiles((parsed as { files?: unknown } | null)?.files);
  if (!parsedFiles.ok) return fail(parsedFiles.status, parsedFiles.message);
  const files = parsedFiles.files;
  // 파일이 없는 호출은 예전처럼 본문 64KB, 있으면 입력 부분만 64KB
  if ((files.length ? Buffer.byteLength(JSON.stringify(rawInputs), 'utf8') : bodyBytes) > WEBHOOK_MAX_BODY_BYTES) return fail(413, '보내는 내용이 너무 큽니다(64KB까지).');
  const inputs = readInputs(rawInputs);
  if (!inputs) return fail(400, 'inputs는 항목 키와 글·숫자 값의 객체여야 합니다.');
  const isAsync = wantsAsync((parsed as { async?: unknown } | null)?.async, request.prefer);
  if (isAsync && files.length) return fail(400, WEBHOOK_ASYNC_NO_FILES);

  if (await deps.orgDisabled(hashWebhookToken(token), deps.now())) return fail(403, WEBHOOK_ORG_DISABLED);
  // 파일은 이름·SHA-256만 해시에 넣는다(파일이 없으면 예전과 같은 해시)
  const fileDigest = files.map((f) => `\n${f.name}:${createHash('sha256').update(f.bytes).digest('hex')}`).join('');
  // 비동기는 해시에 표시를 더한다 — 같은 키로 기다리는 호출과 비동기 호출을 섞으면 다른 요청(422)
  const idempotency = idem.key ? { key: idem.key, requestHash: createHash('sha256').update(canonicalInputs(inputs) + fileDigest + (isAsync ? '\nasync' : ''), 'utf8').digest('hex') } : undefined;
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
  if (isAsync) return handleAsync(deps, webhook, inputs, claim.call_id ?? null);

  let outcome: RunAsOutcome;
  try { outcome = await deps.execute(webhook, inputs, files); }
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

/** 비동기 호출(0087) — 넣고 202. 기록은 기다리는 호출과 같은 규칙(5xx·429는 남기지 않음), 받은 묶음 번호는 기록의 안내 칸에 둬 같은 키에 같은 번호를 돌려준다 */
async function handleAsync(deps: WebhookDeps, webhook: ClaimedWebhook, inputs: Record<string, string>, callId: string | null): Promise<WebhookResponse> {
  let queued: WebhookEnqueueOutcome;
  if (!deps.enqueue) queued = { kind: 'rejected', status: 501, message: '비동기 호출을 받지 않습니다.' };
  else {
    try { queued = await deps.enqueue(webhook, inputs); }
    catch (error) { queued = { kind: 'rejected', status: 500, message: '잠시 뒤 다시 보내 주세요.' }; await deps.log('error', '앱 연동 비동기 넣기 오류', { webhook_id: webhook.id, error: errorText(error) }, webhook.organization_id); }
  }
  let response: WebhookResponse;
  switch (queued.kind) {
    case 'accepted': response = { status: 202, body: { ok: true, data: { status: 'accepted', batch_id: queued.batchId, result_delivery: queued.resultDelivery } } }; break;
    case 'user_unavailable': response = fail(403, WEBHOOK_USER_UNAVAILABLE); break;
    case 'department_changed': response = fail(403, WEBHOOK_DEPARTMENT_CHANGED); break;
    case 'app_changed': response = fail(409, WEBHOOK_APP_CHANGED); break;
    case 'rejected': response = fail(queued.status, queued.message); break;
  }
  const message = queued.kind === 'accepted' ? queued.batchId : String((response.body.error as { message: string }).message).slice(0, 300);
  if (callId) {
    const record: CallRecord | null = response.status >= 500 || response.status === 429 ? null : { http_status: response.status, message, conversation_id: null };
    try { await deps.recordCall(callId, record); }
    catch (error) { await deps.log('warning', '앱 연동 호출 기록을 저장하지 못함', { webhook_id: webhook.id, error: errorText(error) }, webhook.organization_id); }
  }
  if (queued.kind !== 'accepted') await deps.log('warning', '앱 연동 비동기 넣기 실패', { webhook_id: webhook.id, agent_id: webhook.agent_id, status: response.status, kind: queued.kind }, webhook.organization_id);
  return response;
}

/** 같은 키의 처음 응답을 그대로 — 완료면 상태·대화 id, 비동기로 받았으면 그 묶음 번호(0087), 거절이면 그 상태·안내 */
function replayResponse(call: ReplayedCall): WebhookResponse {
  const headers = { [REPLAYED_HEADER]: 'true' };
  if (call.http_status === 202) return { status: 202, body: { ok: true, data: { status: 'accepted', batch_id: call.message, replayed: true } }, headers };
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
    execute: (w, inputs, files) => executeWebhook(w, inputs, {
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
    }, files),
    enqueue: (w, inputs) => enqueueWebhookRun(w, inputs, {
      async documentIdsOf(id) {
        const { data, error } = await supabaseAdmin.from('app_webhooks').select('document_ids').eq('id', id).maybeSingle();
        if (error) throw new Error(`app_webhooks documents: ${error.message}`);
        return ((data as { document_ids?: string[] | null } | null)?.document_ids ?? []);
      },
      async loadUser(userId) {
        const { data, error } = await supabaseAdmin.from('users').select('id, role, department_id, is_active, deleted_at').eq('id', userId).maybeSingle();
        if (error) throw new Error(`users: ${error.message}`);
        return data as Awaited<ReturnType<EnqueueWebhookIo['loadUser']>>;
      },
      async actorFor(user) {
        const { getActorScope } = await import('@/lib/actor-scope');
        return getActorScope({ user: { id: user.id, role: user.role === 'ADMIN' ? 'ADMIN' : 'USER', departmentId: user.department_id }, expires: new Date(Date.now() + 60_000).toISOString() } as Session);
      },
      async appInfo(agentId) {
        const { data, error } = await supabaseAdmin.from('agents').select('name, app_definition').eq('id', agentId).is('deleted_at', null).maybeSingle();
        if (error) throw new Error(`agents: ${error.message}`);
        if (!data) return null;
        const def = (data as { app_definition?: { deliverEndpointId?: unknown } | null }).app_definition;
        return { name: (data as { name: string }).name, deliverEndpointId: typeof def?.deliverEndpointId === 'string' ? def.deliverEndpointId : null };
      },
      async createBatch(actor, body, opts) {
        const { createBatch } = await import('./batches');
        const out = await createBatch(actor, body, opts);
        return out.ok ? { ok: true, batchId: out.batch.id } : { ok: false, status: out.status, message: out.message };
      },
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
