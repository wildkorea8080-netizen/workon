// src/lib/apps/outbound/deliver.ts
// 앱 결과 보내기(0076) — 넣기·서명·주소 확인·보내기·다시 보내기(서버).
//
// - 넣기(`enqueueOutbound`): 앱 실행이 끝까지 마치고 답변을 저장한 뒤, 앱 정의가 고른 보낼 곳이 이 기관의 쓸 수 있는 곳이면 기록 한 줄(pending).
//   보낼 곳이 '보내기 전 확인'(0078)이면 awaiting_approval로 넣고 실행한 직원이 '보내기'를 누를 때까지 보내지 않는다(`approval.ts`, 7일 지나면 그만둠).
//   같은 결과·같은 곳은 한 벌(UNIQUE) — 이어 실행으로 같은 답변이 다시 와도 두 번 넣지 않는다.
// - 보내기(`dispatchDueDeliveries`): 앱 예약 실행기(pg_cron 5분)가 부른다. 차례가 된 기록을 조건부로 차지(sending)하고,
//   보낼 곳·결과를 **그때** 다시 읽어(회수됐거나 대화를 지웠으면 그만둠) 주소를 다시 풀어 사설 주소면 그만둔다(등록 뒤 DNS가 바뀌어도).
//   2xx 보냄 · 3xx·4xx(408·429 빼고) 그만둠 · 그 밖·연결 실패는 1·5·30분·2시간 뒤 다시(5번까지).
// - 결과 한글 파일(2026-11-10): 앱 정의의 `deliverFile`이 켜졌으면 보내기 직전 그 답을 결과 한글 파일로 만들어(예약 결과 파일과 같은 양식 규칙 —
//   앱 설정 양식, 아니면 표준 보고서, 저장하지 않음) `result.file`에 base64로 싣는다. 5MB를 넘으면 파일 없이 `file_omitted`. 만들지 못하면 다시 보낼 일로 센다.
// - 리다이렉트는 따르지 않는다(`redirect: 'manual'`) — 따라가면 승인한 주소 밖으로 결과가 간다. 응답 몸은 2xx일 때 앞 4KB만 읽어
//   받는 쪽 접수 정보(`{"receipt":{"reference","url"}}`, 0080)를 다듬어 남긴다 — 실행한 직원의 '보낸 결과'에 보인다. 그 밖 응답 몸은 버린다.
// - 남은 위험: 주소를 확인한 뒤 실제 연결 사이에 DNS 답이 바뀌는 경우(DNS rebinding)는 막지 못한다 — 보낼 곳은 기관 전체 관리자가 승인한 주소만이다.
import { createHash, createHmac, randomBytes } from 'crypto';
import { lookup } from 'dns/promises';
import { supabaseAdmin } from '@/lib/supabaseAdmin';
import { decryptApiKey } from '@/lib/crypto';
import { logSystem } from '@/lib/logger';
import { buildResultHwpxBytes } from '@/lib/apps/schedule-result-file';
import {
  OUTBOUND_APPROVAL_EXPIRED, OUTBOUND_APPROVAL_MS, OUTBOUND_EVENT, OUTBOUND_HEADERS, OUTBOUND_SECRET_PREFIX, OUTBOUND_STALE_MS, OUTBOUND_TIMEOUT_MS, OUTBOUND_FILE_MAX_BYTES,
  buildOutboundPayload, isIpLiteral, isPrivateAddress, nextAttemptAt, outcomeForStatus, parseOutboundUrl,
  OUTBOUND_MY_DELIVERIES_LIMIT, OUTBOUND_RECEIPT_MAX_BYTES, actionsOf, parseOutboundReceipt, resolveAction,
  type AttemptOutcome, type OutboundFile, type OutboundMyDeliveryView, type OutboundStatus,
} from './spec';

export function generateOutboundSecret(): { secret: string; prefix: string } {
  const secret = `${OUTBOUND_SECRET_PREFIX}${randomBytes(24).toString('base64url')}`;
  return { secret, prefix: secret.slice(0, 12) };
}

/** `sha256=` + HMAC-SHA256(비밀값, "{시각}." + 본문) 16진수 */
export function signOutbound(secret: string, timestamp: string, body: string): string {
  return `sha256=${createHmac('sha256', secret).update(`${timestamp}.${body}`, 'utf8').digest('hex')}`;
}

export type HostCheck = { ok: true } | { ok: false; retry: boolean; message: string };
type Resolve = (host: string) => Promise<Array<{ address: string }>>;
const defaultResolve: Resolve = (host) => lookup(host, { all: true, verbatim: true });

/** 주소 이름이 가리키는 IP가 모두 공개 주소인가 — 하나라도 사설·특수면 막는다. 풀지 못하면 다시 시도할 일 */
export async function checkPublicHost(host: string, resolve: Resolve = defaultResolve): Promise<HostCheck> {
  if (isIpLiteral(host)) return isPrivateAddress(host) ? { ok: false, retry: false, message: '내부망·특수 IP 주소로는 보낼 수 없습니다.' } : { ok: true };
  let addresses: Array<{ address: string }>;
  try { addresses = await resolve(host); } catch { return { ok: false, retry: true, message: '보낼 주소의 이름을 찾지 못했습니다(DNS).' }; }
  if (!addresses.length) return { ok: false, retry: true, message: '보낼 주소의 이름을 찾지 못했습니다(DNS).' };
  if (addresses.some((a) => isPrivateAddress(a.address))) return { ok: false, retry: false, message: '보낼 주소가 내부망·특수 IP를 가리킵니다. 보낼 수 없습니다.' };
  return { ok: true };
}

type BodyLike = { cancel?: () => Promise<void>; getReader?: () => { read(): Promise<{ done: boolean; value?: Uint8Array }>; cancel(): Promise<void> } };
type FetchLike = (url: string, init: RequestInit) => Promise<{ status: number; body?: BodyLike | null }>;

/** 응답 몸의 앞 `max`바이트만 글로 — 넘으면 멈추고 나머지는 버린다. 못 읽으면 빈 글 */
export async function readBodyPrefix(body: BodyLike | null | undefined, max = OUTBOUND_RECEIPT_MAX_BYTES): Promise<string> {
  if (!body?.getReader) { try { await body?.cancel?.(); } catch { /* 버림 */ } return ''; }
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (size < max) {
      const { done, value } = await reader.read();
      if (done || !value) break;
      chunks.push(value); size += value.length;
    }
  } catch { return ''; } finally { try { await reader.cancel(); } catch { /* 버림 */ } }
  return new TextDecoder('utf-8', { fatal: false }).decode(Buffer.concat(chunks.map((c) => Buffer.from(c))).subarray(0, max));
}

/** 한 번 보내기 — 2xx면 응답 몸 앞부분에서 접수 정보를 읽고, 그 밖 응답 몸은 버린다 */
export async function postOnce(url: string, headers: Record<string, string>, body: string, fetchImpl: FetchLike = fetch as unknown as FetchLike, timeoutMs = OUTBOUND_TIMEOUT_MS): Promise<AttemptOutcome> {
  try {
    const res = await fetchImpl(url, { method: 'POST', headers, body, redirect: 'manual', signal: AbortSignal.timeout(timeoutMs) });
    const outcome = outcomeForStatus(res.status);
    if (outcome.kind === 'sent') {
      const receipt = parseOutboundReceipt(await readBodyPrefix(res.body));
      return receipt ? { ...outcome, receipt } : outcome;
    }
    try { await res.body?.cancel?.(); } catch { /* 몸은 버린다 */ }
    return outcome;
  } catch (error) {
    const timedOut = error instanceof Error && (error.name === 'TimeoutError' || error.name === 'AbortError');
    return { kind: 'retry', status: null, error: timedOut ? `받는 쪽이 ${Math.round(timeoutMs / 1000)}초 안에 답하지 않았습니다(잠시 뒤 다시 보냄).` : '받는 쪽에 연결하지 못했습니다(잠시 뒤 다시 보냄).' };
  }
}

/** 앱 실행 결과를 보낼지 — 끝까지 마친 실행(멈춘 단계 없음·글 있음·저장됨)이고 시험 판 실행이 아닐 때만 */
export function shouldDeliver(input: { endpointId?: string; draft: boolean; saved: boolean; text: string; steps: Array<{ status: string }> }): boolean {
  if (!input.endpointId || input.draft || !input.saved || !input.text.trim()) return false;
  return input.steps.every((s) => s.status === 'completed' || s.status === 'skipped');
}

/** 보내기 기록 넣기 — 보낼 곳이 이 기관의 쓸 수 있는 곳일 때만. 확인을 받는 곳이면 'awaiting'(직원이 누를 때까지 안 보냄). 실패해도 던지지 않는다(답변은 이미 저장됐다) */
export async function enqueueOutbound(input: { organizationId: string; endpointId: string; agentId: string; messageId: string; userId: string; action?: string }): Promise<'queued' | 'awaiting' | 'skipped' | 'failed'> {
  try {
    const { data: endpoint, error } = await supabaseAdmin.from('app_outbound_endpoints').select('id, require_approval')
      .eq('id', input.endpointId).eq('organization_id', input.organizationId).is('revoked_at', null).maybeSingle();
    if (error) throw error;
    if (!endpoint) return 'skipped';
    const awaiting = (endpoint as { require_approval?: boolean }).require_approval === true;
    const { error: insertError } = await supabaseAdmin.from('app_outbound_deliveries').insert({
      organization_id: input.organizationId, endpoint_id: input.endpointId, agent_id: input.agentId, message_id: input.messageId, user_id: input.userId,
      status: awaiting ? 'awaiting_approval' : 'pending',
      // 앱이 고른 동작(0081) — 넣을 때 박고, 보낼 때 보낼 곳의 지금 동작 목록과 다시 맞춘다
      ...(input.action ? { action: input.action } : {}),
    });
    if (insertError && insertError.code !== '23505') throw insertError;
    return awaiting ? 'awaiting' : 'queued';
  } catch (error) {
    await logSystem({ level: 'warning', category: 'api', message: '앱 결과 보내기 기록을 넣지 못했습니다', details: { agent_id: input.agentId, message_id: input.messageId, error: error instanceof Error ? error.message : String(error) }, orgId: input.organizationId });
    return 'failed';
  }
}

// ── 보내기 실행기 ─────────────────────────────────────────────────────

export interface DueDelivery { id: string; organization_id: string; endpoint_id: string; agent_id: string; message_id: string; status: 'pending' | 'sending'; attempts: number; claimed_at: string | null; action?: string | null }
export interface DeliveryContext {
  endpoint: { url: string; secret_encrypted: string; organization_id: string; revoked_at: string | null; actions?: unknown } | null;
  message: { content: string; conversation_id: string; created_at: string; role: string; source_references?: Record<string, unknown> | null; agent_version?: number | null } | null;
  agent: { id: string; name: string; app_definition?: { deliverFile?: unknown; exportTemplateId?: unknown } | null } | null;
}
export type FinishPatch = { status: 'sent' | 'pending' | 'gave_up'; attempts: number; last_status: number | null; last_error: string | null; next_attempt_at?: string; sent_at?: string; receipt_ref?: string | null; receipt_url?: string | null };

export interface OutboundDeps {
  now(): number;
  listDue(nowIso: string, staleIso: string, limit: number): Promise<DueDelivery[] | null>;
  claim(row: DueDelivery, nowIso: string, staleIso: string): Promise<boolean>;
  load(row: DueDelivery): Promise<DeliveryContext | null>;
  finish(id: string, patch: FinishPatch): Promise<void>;
  decrypt(enc: string): string;
  checkHost(host: string): Promise<HostCheck>;
  post(url: string, headers: Record<string, string>, body: string): Promise<AttemptOutcome>;
  log(message: string, details: Record<string, unknown>, orgId: string): Promise<void>;
  /** 결과 한글 파일 바이트(2026-11-10) — 앱 정의가 `deliverFile`일 때만 부른다. 던지면 다시 보낼 일 */
  buildFile?(ctx: DeliveryContext & { message: NonNullable<DeliveryContext['message']>; agent: NonNullable<DeliveryContext['agent']> }): Promise<{ name: string; bytes: Buffer }>;
  /** 확인 기한(7일)이 지난 확인 기다림 기록을 그만둠으로 — 바꾼 수(0078) */
  expireApprovals?(cutoffIso: string): Promise<number>;
}

export type DispatchResult = { claimed: number; sent: number; retried: number; gaveUp: number; expired: number };

/** 차례가 된 보내기를 한 번에 `limit`개까지, `budgetMs` 안에서. 던지지 않는다 */
export async function dispatchDueDeliveries(deps: OutboundDeps, opts: { limit?: number; budgetMs?: number } = {}): Promise<DispatchResult> {
  const start = deps.now();
  const result: DispatchResult = { claimed: 0, sent: 0, retried: 0, gaveUp: 0, expired: 0 };
  const iso = (ms: number) => new Date(ms).toISOString();
  if (deps.expireApprovals) {
    try { result.expired = await deps.expireApprovals(iso(start - OUTBOUND_APPROVAL_MS)); } catch { /* 다음 차례에 다시 */ }
  }
  let due: DueDelivery[] | null;
  try { due = await deps.listDue(iso(start), iso(start - OUTBOUND_STALE_MS), opts.limit ?? 20); } catch { due = null; }
  for (const row of due ?? []) {
    if (deps.now() - start > (opts.budgetMs ?? 25_000)) break;
    const now = deps.now();
    if (!(await deps.claim(row, iso(now), iso(now - OUTBOUND_STALE_MS)).catch(() => false))) continue;
    result.claimed++;
    const attempt = row.attempts + 1;
    const giveUp = async (error: string, status: number | null = null, count = attempt) => {
      await deps.finish(row.id, { status: 'gave_up', attempts: count, last_status: status, last_error: error.slice(0, 300) });
      result.gaveUp++;
    };
    let ctx: DeliveryContext | null;
    try { ctx = await deps.load(row); } catch { ctx = null; }
    if (!ctx) {
      // 읽기 실패는 다음 차례에 다시(시도 수는 세지 않는다)
      await deps.finish(row.id, { status: 'pending', attempts: row.attempts, last_status: null, last_error: '보낼 곳·결과를 읽지 못했습니다(잠시 뒤 다시).', next_attempt_at: iso(now + 60_000) });
      result.retried++;
      continue;
    }
    if (!ctx.endpoint || ctx.endpoint.revoked_at || ctx.endpoint.organization_id !== row.organization_id) { await giveUp('보낼 곳이 회수됐거나 없습니다.', null, row.attempts); continue; }
    if (!ctx.message || ctx.message.role !== 'assistant' || !ctx.agent) { await giveUp('보낼 결과를 찾지 못했습니다(대화·앱을 지웠을 수 있습니다).', null, row.attempts); continue; }
    const url = parseOutboundUrl(ctx.endpoint.url);
    if (!url.ok) { await giveUp(url.message, null, row.attempts); continue; }
    const action = resolveAction(actionsOf(ctx.endpoint.actions), row.action);
    if (!action.ok) { await giveUp(action.message, null, row.attempts); continue; }
    const secret = deps.decrypt(ctx.endpoint.secret_encrypted);
    if (!secret) {
      await deps.log('앱 결과 보내기 — 서명 비밀값을 읽지 못했습니다(ENCRYPTION_KEY 확인)', { delivery_id: row.id, endpoint_id: row.endpoint_id }, row.organization_id);
      await giveUp('서명 비밀값을 읽지 못했습니다. 보낼 곳을 다시 만들어 주세요.', null, row.attempts);
      continue;
    }
    const host = await deps.checkHost(url.host);
    let outcome: AttemptOutcome;
    let file: OutboundFile | undefined;
    let fileError: string | null = null;
    if (host.ok && ctx.agent.app_definition?.deliverFile === true && deps.buildFile) {
      try {
        const built = await deps.buildFile({ ...ctx, message: ctx.message, agent: ctx.agent });
        file = built.bytes.length > OUTBOUND_FILE_MAX_BYTES
          ? { omitted: 'too_large', size: built.bytes.length }
          : { name: built.name, size: built.bytes.length, sha256: createHash('sha256').update(built.bytes).digest('hex'), base64: built.bytes.toString('base64') };
      } catch {
        fileError = '결과 한글 파일을 만들지 못했습니다(잠시 뒤 다시 보냄).';
      }
    }
    if (!host.ok) outcome = host.retry ? { kind: 'retry', status: null, error: host.message } : { kind: 'give_up', status: null, error: host.message };
    else if (fileError) outcome = { kind: 'retry', status: null, error: fileError };
    else {
      const sentAt = iso(deps.now());
      const timestamp = String(Math.floor(deps.now() / 1000));
      const body = buildOutboundPayload({
        deliveryId: row.id, sentAt, app: { id: ctx.agent.id, name: ctx.agent.name },
        run: { messageId: row.message_id, conversationId: ctx.message.conversation_id, completedAt: ctx.message.created_at },
        text: ctx.message.content,
        ...(file ? { file } : {}),
        ...(action.action ? { action: action.action } : {}),
      });
      outcome = await deps.post(url.url, {
        'Content-Type': 'application/json; charset=utf-8',
        'User-Agent': 'WORKON-Outbound/1',
        [OUTBOUND_HEADERS.event]: OUTBOUND_EVENT,
        [OUTBOUND_HEADERS.delivery]: row.id,
        [OUTBOUND_HEADERS.idempotency]: row.id,
        [OUTBOUND_HEADERS.timestamp]: timestamp,
        [OUTBOUND_HEADERS.signature]: signOutbound(secret, timestamp, body),
        ...(action.action ? { [OUTBOUND_HEADERS.action]: action.action.key } : {}),
      }, body);
    }
    const done = deps.now();
    if (outcome.kind === 'sent') {
      await deps.finish(row.id, { status: 'sent', attempts: attempt, last_status: outcome.status, last_error: null, sent_at: iso(done), ...(outcome.receipt ? { receipt_ref: outcome.receipt.reference, receipt_url: outcome.receipt.url } : {}) });
      result.sent++;
    } else if (outcome.kind === 'retry') {
      const next = nextAttemptAt(attempt, done);
      if (next === null) await giveUp(`${outcome.error} — ${attempt}번 시도해 그만둡니다.`, outcome.status);
      else {
        await deps.finish(row.id, { status: 'pending', attempts: attempt, last_status: outcome.status, last_error: outcome.error.slice(0, 300), next_attempt_at: iso(next) });
        result.retried++;
      }
    } else {
      await giveUp(outcome.error, outcome.status);
    }
  }
  return result;
}

type Row = Record<string, unknown>;

/** 실제 DB·네트워크로 */
export function outboundDeps(): OutboundDeps {
  return {
    now: () => Date.now(),
    async listDue(nowIso, staleIso, limit) {
      const { data, error } = await supabaseAdmin.from('app_outbound_deliveries')
        .select('id, organization_id, endpoint_id, agent_id, message_id, status, attempts, claimed_at, action')
        .or(`and(status.eq.pending,next_attempt_at.lte.${nowIso}),and(status.eq.sending,claimed_at.lt.${staleIso})`)
        .order('next_attempt_at', { ascending: true }).limit(limit);
      if (error) return null;
      return (data ?? []) as DueDelivery[];
    },
    async claim(row, nowIso, staleIso) {
      let q = supabaseAdmin.from('app_outbound_deliveries').update({ status: 'sending', claimed_at: nowIso }).eq('id', row.id);
      q = row.status === 'pending' ? q.eq('status', 'pending').lte('next_attempt_at', nowIso) : q.eq('status', 'sending').lt('claimed_at', staleIso);
      const { data, error } = await q.select('id');
      return !error && Boolean(data?.length);
    },
    async load(row) {
      const [endpoint, message, agent] = await Promise.all([
        supabaseAdmin.from('app_outbound_endpoints').select('url, secret_encrypted, organization_id, revoked_at, actions').eq('id', row.endpoint_id).maybeSingle(),
        supabaseAdmin.from('messages').select('content, conversation_id, created_at, role, source_references, agent_version').eq('id', row.message_id).maybeSingle(),
        supabaseAdmin.from('agents').select('id, name, app_definition').eq('id', row.agent_id).maybeSingle(),
      ]);
      if (endpoint.error || message.error || agent.error) return null;
      return {
        endpoint: endpoint.data as DeliveryContext['endpoint'],
        message: message.data as DeliveryContext['message'],
        agent: agent.data as DeliveryContext['agent'],
      };
    },
    async finish(id, patch) {
      const row: Row = { ...patch, claimed_at: null };
      await supabaseAdmin.from('app_outbound_deliveries').update(row).eq('id', id).eq('status', 'sending');
    },
    decrypt: (enc) => decryptApiKey(enc),
    checkHost: (host) => checkPublicHost(host),
    post: (url, headers, body) => postOnce(url, headers, body),
    async buildFile(ctx) {
      const built = await buildResultHwpxBytes({
        agentId: ctx.agent.id, appName: ctx.agent.name, exportTemplateId: ctx.agent.app_definition?.exportTemplateId,
        message: { content: ctx.message.content, source_references: ctx.message.source_references ?? null, agent_version: ctx.message.agent_version ?? null },
      });
      return { name: built.fileName, bytes: built.bytes };
    },
    async log(message, details, orgId) { await logSystem({ level: 'critical', category: 'api', message, details, orgId }); },
    async expireApprovals(cutoffIso) {
      const { data, error } = await supabaseAdmin.from('app_outbound_deliveries')
        .update({ status: 'gave_up', last_error: OUTBOUND_APPROVAL_EXPIRED })
        .eq('status', 'awaiting_approval').lt('created_at', cutoffIso).select('id');
      if (error) throw error;
      return data?.length ?? 0;
    },
  };
}

/** 이 직원이 실행한 결과의 보낸 기록(0080) — 확인 기다림은 빼고 최근 20개, 앱으로 거를 수 있다. 결과 글·보낼 곳 주소는 싣지 않는다 */
export async function listMyDeliveries(actor: { userId: string; organizationId: string }, agentId: string | null): Promise<{ ok: true; items: OutboundMyDeliveryView[] } | { ok: false; status: number; message: string }> {
  if (agentId !== null && !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(agentId)) return { ok: false, status: 400, message: '앱을 확인해 주세요.' };
  let q = supabaseAdmin.from('app_outbound_deliveries').select('id, agent_id, endpoint_id, message_id, status, attempts, created_at, sent_at, next_attempt_at, last_error, receipt_ref, receipt_url')
    .eq('user_id', actor.userId).eq('organization_id', actor.organizationId).neq('status', 'awaiting_approval');
  if (agentId) q = q.eq('agent_id', agentId);
  const { data, error } = await q.order('created_at', { ascending: false }).limit(OUTBOUND_MY_DELIVERIES_LIMIT);
  if (error) return { ok: false, status: 503, message: '보낸 결과를 불러오지 못했습니다.' };
  const rows = (data ?? []) as Array<{ id: string; agent_id: string; endpoint_id: string; message_id: string; status: OutboundStatus; attempts: number; created_at: string; sent_at: string | null; next_attempt_at: string | null; last_error: string | null; receipt_ref: string | null; receipt_url: string | null }>;
  if (!rows.length) return { ok: true, items: [] };
  const [endpoints, agents, messages] = await Promise.all([
    supabaseAdmin.from('app_outbound_endpoints').select('id, name').eq('organization_id', actor.organizationId).in('id', [...new Set(rows.map((r) => r.endpoint_id))]),
    supabaseAdmin.from('agents').select('id, name').eq('organization_id', actor.organizationId).in('id', [...new Set(rows.map((r) => r.agent_id))]),
    // 대화 링크 — 이 직원의 대화만
    supabaseAdmin.from('messages').select('id, conversation_id, conversation:conversations!inner(user_id)').in('id', [...new Set(rows.map((r) => r.message_id))]).eq('conversation.user_id', actor.userId),
  ]);
  if (endpoints.error || agents.error || messages.error) return { ok: false, status: 503, message: '보낸 결과를 불러오지 못했습니다.' };
  const endpointNames = new Map(((endpoints.data ?? []) as Array<{ id: string; name: string }>).map((e) => [e.id, e.name]));
  const agentNames = new Map(((agents.data ?? []) as Array<{ id: string; name: string }>).map((a) => [a.id, a.name]));
  const conversations = new Map(((messages.data ?? []) as unknown as Array<{ id: string; conversation_id: string }>).map((m) => [m.id, m.conversation_id]));
  return {
    ok: true,
    items: rows.map((r) => ({
      id: r.id, appName: agentNames.get(r.agent_id) ?? '(앱)', endpointName: endpointNames.get(r.endpoint_id) ?? '(보낼 곳)', status: r.status, attempts: r.attempts,
      createdAt: r.created_at, sentAt: r.sent_at, nextAttemptAt: r.status === 'pending' ? r.next_attempt_at : null, lastError: r.status === 'sent' ? null : r.last_error,
      receiptRef: r.receipt_ref, receiptUrl: r.receipt_url && r.receipt_url.startsWith('https://') ? r.receipt_url : null, conversationId: conversations.get(r.message_id) ?? null,
    })),
  };
}
