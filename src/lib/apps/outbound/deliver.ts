// src/lib/apps/outbound/deliver.ts
// 앱 결과 보내기(0076) — 넣기·서명·주소 확인·보내기·다시 보내기(서버).
//
// - 넣기(`enqueueOutbound`): 앱 실행이 끝까지 마치고 답변을 저장한 뒤, 앱 정의가 고른 보낼 곳이 이 기관의 쓸 수 있는 곳이면 기록 한 줄(pending).
//   같은 결과·같은 곳은 한 벌(UNIQUE) — 이어 실행으로 같은 답변이 다시 와도 두 번 넣지 않는다.
// - 보내기(`dispatchDueDeliveries`): 앱 예약 실행기(pg_cron 5분)가 부른다. 차례가 된 기록을 조건부로 차지(sending)하고,
//   보낼 곳·결과를 **그때** 다시 읽어(회수됐거나 대화를 지웠으면 그만둠) 주소를 다시 풀어 사설 주소면 그만둔다(등록 뒤 DNS가 바뀌어도).
//   2xx 보냄 · 3xx·4xx(408·429 빼고) 그만둠 · 그 밖·연결 실패는 1·5·30분·2시간 뒤 다시(5번까지).
// - 리다이렉트는 따르지 않는다(`redirect: 'manual'`) — 따라가면 승인한 주소 밖으로 결과가 간다. 응답 몸은 읽지 않는다.
// - 남은 위험: 주소를 확인한 뒤 실제 연결 사이에 DNS 답이 바뀌는 경우(DNS rebinding)는 막지 못한다 — 보낼 곳은 기관 전체 관리자가 승인한 주소만이다.
import { createHmac, randomBytes } from 'crypto';
import { lookup } from 'dns/promises';
import { supabaseAdmin } from '@/lib/supabaseAdmin';
import { decryptApiKey } from '@/lib/crypto';
import { logSystem } from '@/lib/logger';
import {
  OUTBOUND_EVENT, OUTBOUND_HEADERS, OUTBOUND_SECRET_PREFIX, OUTBOUND_STALE_MS, OUTBOUND_TIMEOUT_MS,
  buildOutboundPayload, isIpLiteral, isPrivateAddress, nextAttemptAt, outcomeForStatus, parseOutboundUrl,
  type AttemptOutcome,
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

type FetchLike = (url: string, init: RequestInit) => Promise<{ status: number; body?: { cancel?: () => Promise<void> } | null }>;

/** 한 번 보내기 — 응답 몸은 읽지 않는다 */
export async function postOnce(url: string, headers: Record<string, string>, body: string, fetchImpl: FetchLike = fetch as unknown as FetchLike, timeoutMs = OUTBOUND_TIMEOUT_MS): Promise<AttemptOutcome> {
  try {
    const res = await fetchImpl(url, { method: 'POST', headers, body, redirect: 'manual', signal: AbortSignal.timeout(timeoutMs) });
    try { await res.body?.cancel?.(); } catch { /* 몸은 버린다 */ }
    return outcomeForStatus(res.status);
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

/** 보내기 기록 넣기 — 보낼 곳이 이 기관의 쓸 수 있는 곳일 때만. 실패해도 던지지 않는다(답변은 이미 저장됐다) */
export async function enqueueOutbound(input: { organizationId: string; endpointId: string; agentId: string; messageId: string; userId: string }): Promise<'queued' | 'skipped' | 'failed'> {
  try {
    const { data: endpoint, error } = await supabaseAdmin.from('app_outbound_endpoints').select('id')
      .eq('id', input.endpointId).eq('organization_id', input.organizationId).is('revoked_at', null).maybeSingle();
    if (error) throw error;
    if (!endpoint) return 'skipped';
    const { error: insertError } = await supabaseAdmin.from('app_outbound_deliveries').insert({
      organization_id: input.organizationId, endpoint_id: input.endpointId, agent_id: input.agentId, message_id: input.messageId, user_id: input.userId,
    });
    if (insertError && insertError.code !== '23505') throw insertError;
    return 'queued';
  } catch (error) {
    await logSystem({ level: 'warning', category: 'api', message: '앱 결과 보내기 기록을 넣지 못했습니다', details: { agent_id: input.agentId, message_id: input.messageId, error: error instanceof Error ? error.message : String(error) }, orgId: input.organizationId });
    return 'failed';
  }
}

// ── 보내기 실행기 ─────────────────────────────────────────────────────

export interface DueDelivery { id: string; organization_id: string; endpoint_id: string; agent_id: string; message_id: string; status: 'pending' | 'sending'; attempts: number; claimed_at: string | null }
export interface DeliveryContext {
  endpoint: { url: string; secret_encrypted: string; organization_id: string; revoked_at: string | null } | null;
  message: { content: string; conversation_id: string; created_at: string; role: string } | null;
  agent: { id: string; name: string } | null;
}
export type FinishPatch = { status: 'sent' | 'pending' | 'gave_up'; attempts: number; last_status: number | null; last_error: string | null; next_attempt_at?: string; sent_at?: string };

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
}

export type DispatchResult = { claimed: number; sent: number; retried: number; gaveUp: number };

/** 차례가 된 보내기를 한 번에 `limit`개까지, `budgetMs` 안에서. 던지지 않는다 */
export async function dispatchDueDeliveries(deps: OutboundDeps, opts: { limit?: number; budgetMs?: number } = {}): Promise<DispatchResult> {
  const start = deps.now();
  const result: DispatchResult = { claimed: 0, sent: 0, retried: 0, gaveUp: 0 };
  const iso = (ms: number) => new Date(ms).toISOString();
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
    const secret = deps.decrypt(ctx.endpoint.secret_encrypted);
    if (!secret) {
      await deps.log('앱 결과 보내기 — 서명 비밀값을 읽지 못했습니다(ENCRYPTION_KEY 확인)', { delivery_id: row.id, endpoint_id: row.endpoint_id }, row.organization_id);
      await giveUp('서명 비밀값을 읽지 못했습니다. 보낼 곳을 다시 만들어 주세요.', null, row.attempts);
      continue;
    }
    const host = await deps.checkHost(url.host);
    let outcome: AttemptOutcome;
    if (!host.ok) outcome = host.retry ? { kind: 'retry', status: null, error: host.message } : { kind: 'give_up', status: null, error: host.message };
    else {
      const sentAt = iso(deps.now());
      const timestamp = String(Math.floor(deps.now() / 1000));
      const body = buildOutboundPayload({
        deliveryId: row.id, sentAt, app: { id: ctx.agent.id, name: ctx.agent.name },
        run: { messageId: row.message_id, conversationId: ctx.message.conversation_id, completedAt: ctx.message.created_at },
        text: ctx.message.content,
      });
      outcome = await deps.post(url.url, {
        'Content-Type': 'application/json; charset=utf-8',
        'User-Agent': 'WORKON-Outbound/1',
        [OUTBOUND_HEADERS.event]: OUTBOUND_EVENT,
        [OUTBOUND_HEADERS.delivery]: row.id,
        [OUTBOUND_HEADERS.idempotency]: row.id,
        [OUTBOUND_HEADERS.timestamp]: timestamp,
        [OUTBOUND_HEADERS.signature]: signOutbound(secret, timestamp, body),
      }, body);
    }
    const done = deps.now();
    if (outcome.kind === 'sent') {
      await deps.finish(row.id, { status: 'sent', attempts: attempt, last_status: outcome.status, last_error: null, sent_at: iso(done) });
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
        .select('id, organization_id, endpoint_id, agent_id, message_id, status, attempts, claimed_at')
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
        supabaseAdmin.from('app_outbound_endpoints').select('url, secret_encrypted, organization_id, revoked_at').eq('id', row.endpoint_id).maybeSingle(),
        supabaseAdmin.from('messages').select('content, conversation_id, created_at, role').eq('id', row.message_id).maybeSingle(),
        supabaseAdmin.from('agents').select('id, name').eq('id', row.agent_id).maybeSingle(),
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
    async log(message, details, orgId) { await logSystem({ level: 'critical', category: 'api', message, details, orgId }); },
  };
}
