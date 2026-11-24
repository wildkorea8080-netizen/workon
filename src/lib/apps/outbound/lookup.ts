// src/lib/apps/outbound/lookup.ts
// 기관 연동 시스템 조회(0102, 2026-11-24) — 입력형 앱의 조회 단계(`lookup.tool = 'external'`)가 기관 전체 관리자가 승인한 보낼 곳(0076)에
// 조회어를 보내고 그 답을 다음 단계의 자료로 쓴다(알리웍스 대화형 앱의 '연동 노드(REST)' 꼴 — 고정된 곳 하나를 정해 둔 조회어로).
//
// - 쓸 수 있는 곳: 이 앱의 기관 것·회수되지 않음·관리자가 '앱 조회에도 쓰기'(`lookup_enabled`)를 켠 곳. **실행 때마다 다시 본다**(앱을 저장한 뒤 회수·끄기가 있을 수 있다).
// - 동작(0081): 그 곳이 동작을 정해 두었으면 앱이 고른 동작이 지금 목록에 있어야 한다(결과 보내기와 같은 `resolveAction`).
// - 보내기는 결과 보내기와 같은 담장: https만·주소를 다시 풀어 사설 주소면 막음·리다이렉트 안 따름·8초·HMAC 서명(`X-Workon-Signature`, 같은 비밀값).
//   몸은 `{ event: 'app.lookup', lookup_id, requested_at, query, action?, app: { id, name, version } }` — **조회어만**(입력값 전체·대화·결과 글은 보내지 않는다).
// - 답: 2xx만, 앞 64KB만 읽어 `parseLookupResponse`(JSON `result`·`text`·`answer`·`sources`, 아니면 글 그대로). 그 밖은 실패(다시 시도 없음 — 직원이 다시 실행).
// - 던지지 않는다 — 실패는 `isError`로(조회 단계가 그 글로 멈춘다). 받는 쪽 원문·응답 몸은 운영 기록에 남기지 않는다(곳 id·상태 코드만).
import { randomUUID } from 'crypto';
import { supabaseAdmin } from '@/lib/supabaseAdmin';
import { decryptApiKey } from '@/lib/crypto';
import { logSystem } from '@/lib/logger';
import { checkPublicHost, signOutbound, type HostCheck } from './deliver';
import {
  OUTBOUND_HEADERS, OUTBOUND_LOOKUP_DISABLED, OUTBOUND_LOOKUP_EVENT, OUTBOUND_LOOKUP_GONE, OUTBOUND_LOOKUP_MAX_BYTES, OUTBOUND_TIMEOUT_MS,
  actionsOf, parseLookupResponse, parseOutboundUrl, resolveAction,
} from './spec';

export type ExternalLookupResult = { content: string; sources: Array<{ title: string; url: string }>; isError?: boolean };
export type ExternalLookupContext = { organizationId: string; agentId: string; appName: string; appVersion: number | null };
type EndpointRow = { id: string; organization_id: string; name: string; url: string; secret_encrypted: string; revoked_at: string | null; lookup_enabled?: boolean | null; actions?: unknown };
type ResponseLike = { status: number; headers?: { get(name: string): string | null }; body?: { getReader?: () => { read(): Promise<{ done: boolean; value?: Uint8Array }>; cancel(): Promise<void> }; cancel?: () => Promise<void> } | null };

export interface ExternalLookupDeps {
  loadEndpoint(id: string): Promise<EndpointRow | null>;
  decrypt(enc: string): string;
  checkHost(host: string): Promise<HostCheck>;
  fetch(url: string, init: RequestInit): Promise<ResponseLike>;
  now(): number;
  newId(): string;
  log(message: string, details: Record<string, unknown>, orgId: string): Promise<void>;
}

const fail = (content: string): ExternalLookupResult => ({ content, sources: [], isError: true });

async function readPrefix(res: ResponseLike, max: number): Promise<string> {
  const body = res.body;
  if (!body?.getReader) { try { await body?.cancel?.(); } catch { /* 버림 */ } return ''; }
  const reader = body.getReader();
  const chunks: Buffer[] = [];
  let size = 0;
  try {
    while (size < max) {
      const { done, value } = await reader.read();
      if (done || !value) break;
      chunks.push(Buffer.from(value)); size += value.length;
    }
  } finally { try { await reader.cancel(); } catch { /* 버림 */ } }
  return new TextDecoder('utf-8', { fatal: false }).decode(Buffer.concat(chunks).subarray(0, max));
}

export async function callExternalLookup(
  ctx: ExternalLookupContext,
  req: { endpointId: string | undefined; action: string | undefined; query: string },
  deps: ExternalLookupDeps = externalLookupDeps(),
): Promise<ExternalLookupResult> {
  if (!req.endpointId) return fail(OUTBOUND_LOOKUP_GONE);
  let row: EndpointRow | null;
  try { row = await deps.loadEndpoint(req.endpointId); } catch { return fail('연동 시스템 정보를 지금 읽지 못했습니다. 잠시 뒤 다시 실행해 주세요.'); }
  if (!row || row.organization_id !== ctx.organizationId || row.revoked_at) return fail(OUTBOUND_LOOKUP_GONE);
  if (row.lookup_enabled !== true) return fail(OUTBOUND_LOOKUP_DISABLED);
  const action = resolveAction(actionsOf(row.actions), req.action);
  if (!action.ok) {
    return fail(req.action
      ? `${row.name}: 조회 단계가 고른 동작이 연동 시스템에서 없어졌습니다 — 앱 설정의 조회 단계에서 동작을 다시 골라 주세요.`
      : `${row.name}: 이 연동 시스템은 동작을 정해 두었습니다 — 앱 설정의 조회 단계에서 동작을 골라 주세요.`);
  }
  const url = parseOutboundUrl(row.url);
  if (!url.ok) return fail(`${row.name}: 주소를 쓸 수 없습니다 — ${url.message}`);
  const host = await deps.checkHost(url.host.replace(/^\[|\]$/g, ''));
  if (!host.ok) return fail(`${row.name}: ${host.message.replace('보낼', '부를')}`);
  let secret: string;
  try { secret = deps.decrypt(row.secret_encrypted); } catch { return fail(`${row.name}: 서명 비밀값을 풀지 못했습니다 — 기관 관리자에게 알려 주세요.`); }

  const lookupId = deps.newId();
  const now = deps.now();
  const timestamp = String(Math.floor(now / 1000));
  const body = JSON.stringify({
    event: OUTBOUND_LOOKUP_EVENT, lookup_id: lookupId, requested_at: new Date(now).toISOString(), query: req.query,
    ...(action.action ? { action: { key: action.action.key, label: action.action.label } } : {}),
    app: { id: ctx.agentId, name: ctx.appName, ...(ctx.appVersion !== null ? { version: ctx.appVersion } : {}) },
  });
  let res: ResponseLike;
  try {
    res = await deps.fetch(url.url, {
      method: 'POST', redirect: 'manual', signal: AbortSignal.timeout(OUTBOUND_TIMEOUT_MS), body,
      headers: {
        'Content-Type': 'application/json; charset=utf-8', Accept: 'application/json, text/plain;q=0.9', 'User-Agent': 'WORKON-Outbound/1',
        [OUTBOUND_HEADERS.event]: OUTBOUND_LOOKUP_EVENT, [OUTBOUND_HEADERS.delivery]: lookupId, [OUTBOUND_HEADERS.idempotency]: lookupId,
        [OUTBOUND_HEADERS.timestamp]: timestamp, [OUTBOUND_HEADERS.signature]: signOutbound(secret, timestamp, body),
        ...(action.action ? { [OUTBOUND_HEADERS.action]: action.action.key } : {}),
      },
    });
  } catch (error) {
    const timedOut = error instanceof Error && (error.name === 'TimeoutError' || error.name === 'AbortError');
    await deps.log('기관 연동 시스템 조회에 연결하지 못했습니다', { endpoint_id: row.id, timed_out: timedOut }, ctx.organizationId).catch(() => {});
    return fail(`${row.name}: ${timedOut ? `${Math.round(OUTBOUND_TIMEOUT_MS / 1000)}초 안에 답하지 않았습니다` : '연결하지 못했습니다'}. 잠시 뒤 다시 실행해 주세요.`);
  }
  if (res.status < 200 || res.status >= 300) {
    try { await res.body?.cancel?.(); } catch { /* 버림 */ }
    await deps.log('기관 연동 시스템 조회가 실패 상태로 답했습니다', { endpoint_id: row.id, status: res.status }, ctx.organizationId).catch(() => {});
    return fail(`${row.name}: ${res.status >= 300 && res.status < 400 ? '다른 주소로 넘기려 해 따르지 않았습니다' : `HTTP ${res.status}로 답했습니다`}.`);
  }
  let text: string;
  try { text = await readPrefix(res, OUTBOUND_LOOKUP_MAX_BYTES); } catch { return fail(`${row.name}: 답을 끝까지 읽지 못했습니다. 잠시 뒤 다시 실행해 주세요.`); }
  const parsed = parseLookupResponse(text);
  if (!parsed) return fail(`${row.name}: 빈 답을 보냈습니다.`);
  return { content: `[${row.name}] 조회 결과\n${parsed.content}`, sources: parsed.sources };
}

export function externalLookupDeps(): ExternalLookupDeps {
  return {
    async loadEndpoint(id) {
      if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) return null;
      const { data, error } = await supabaseAdmin.from('app_outbound_endpoints')
        .select('id, organization_id, name, url, secret_encrypted, revoked_at, lookup_enabled, actions').eq('id', id).maybeSingle();
      if (error) throw new Error(`app_outbound_endpoints: ${error.message}`);
      return (data as EndpointRow | null) ?? null;
    },
    decrypt: (enc) => decryptApiKey(enc),
    checkHost: (host) => checkPublicHost(host),
    fetch: (url, init) => fetch(url, init) as unknown as Promise<ResponseLike>,
    now: () => Date.now(),
    newId: () => randomUUID(),
    log: (message, details, orgId) => logSystem({ level: 'warning', category: 'api', message, details, orgId }),
  };
}
