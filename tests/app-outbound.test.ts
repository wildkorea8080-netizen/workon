import { readFileSync } from 'fs';
import { createHmac } from 'crypto';
import { describe, expect, it, vi } from 'vitest';
import {
  OUTBOUND_BACKOFF_MS, OUTBOUND_HEADERS, OUTBOUND_MAX_ATTEMPTS, OUTBOUND_TEXT_MAX, buildOutboundPayload, isPrivateAddress, nextAttemptAt,
  outcomeForStatus, parseCreateEndpoint, parseOutboundUrl, parseRevokeReason,
} from '@/lib/apps/outbound/spec';
import {
  checkPublicHost, dispatchDueDeliveries, generateOutboundSecret, postOnce, shouldDeliver, signOutbound,
  type DeliveryContext, type DueDelivery, type FinishPatch, type OutboundDeps,
} from '@/lib/apps/outbound/deliver';
import { wholeOrgAdminProblem } from '@/lib/apps/outbound/admin';
import { validateAppDefinition } from '@/lib/apps/definition';
import type { ActorScope } from '@/lib/agent-permissions';

/** 앱 결과를 외부 시스템으로 보내기(0076) — 주소 검사·서명·보내기 판정·다시 보내기·실행기·연결 */

describe('주소', () => {
  it('https·443·사용자 정보 없음·조각 없음·내부망 이름 아님만', () => {
    expect(parseOutboundUrl('https://hook.example.go.kr/workon?x=1')).toMatchObject({ ok: true, host: 'hook.example.go.kr' });
    expect(parseOutboundUrl('https://hook.example.com:443/a')).toMatchObject({ ok: true });
    for (const bad of ['http://hook.example.com', 'https://u:p@hook.example.com', 'https://hook.example.com:8443', 'https://hook.example.com/#a',
      'https://localhost/x', 'https://intra.local/x', 'https://svc.internal/', 'https://intranet/', 'https://10.0.0.5/', 'https://[::1]/', 'https://169.254.169.254/latest',
      'ftp://x.com', '', 7, `https://a.com/${'x'.repeat(600)}`, 'https://a.com/‮']) {
      expect(parseOutboundUrl(bad)).toMatchObject({ ok: false });
    }
  });

  it('사설·특수 IP는 막고 공개 IP는 통과(꼴을 모르면 막음)', () => {
    for (const ip of ['10.1.2.3', '127.0.0.1', '0.0.0.0', '172.16.0.1', '172.31.255.255', '192.168.0.1', '169.254.169.254', '100.64.0.1', '224.0.0.1', '255.255.255.255', '198.18.0.1', '192.0.2.1',
      '::1', '::', 'fc00::1', 'fd12::1', 'fe80::1', 'ff02::1', '::ffff:10.0.0.1', '::ffff:127.0.0.1', '2001:db8::1', 'not-an-ip', '999.1.1.1']) {
      expect(isPrivateAddress(ip), ip).toBe(true);
    }
    for (const ip of ['8.8.8.8', '211.234.1.1', '172.32.0.1', '100.128.0.1', '2600:1f18::1', '::ffff:8.8.8.8']) expect(isPrivateAddress(ip), ip).toBe(false);
  });

  it('주소 이름이 가리키는 IP — 하나라도 사설이면 그만두고, 못 풀면 다시', async () => {
    expect(await checkPublicHost('hook.example.com', async () => [{ address: '8.8.8.8' }])).toEqual({ ok: true });
    expect(await checkPublicHost('hook.example.com', async () => [{ address: '8.8.8.8' }, { address: '10.0.0.1' }])).toMatchObject({ ok: false, retry: false });
    expect(await checkPublicHost('hook.example.com', async () => { throw new Error('ENOTFOUND'); })).toMatchObject({ ok: false, retry: true });
    expect(await checkPublicHost('hook.example.com', async () => [])).toMatchObject({ ok: false, retry: true });
    expect(await checkPublicHost('8.8.8.8', async () => { throw new Error('부르면 안 됨'); })).toEqual({ ok: true });
  });

  it('만들기 입력·회수 사유', () => {
    expect(parseCreateEndpoint({ name: ' 전자결재  연계 ', url: 'https://hook.example.com/a' })).toEqual({ ok: true, value: { name: '전자결재 연계', url: 'https://hook.example.com/a', requireApproval: false } });
    expect(parseCreateEndpoint({ name: '', url: 'https://hook.example.com' })).toMatchObject({ ok: false });
    expect(parseCreateEndpoint({ name: 'x'.repeat(61), url: 'https://hook.example.com' })).toMatchObject({ ok: false });
    expect(parseCreateEndpoint(null)).toMatchObject({ ok: false });
    expect(parseRevokeReason('  받는 시스템 폐기  ')).toEqual({ ok: true, reason: '받는 시스템 폐기' });
    expect(parseRevokeReason('짧음')).toMatchObject({ ok: false });
  });
});

describe('서명·몸·판정', () => {
  it('서명은 HMAC-SHA256(비밀값, "시각." + 본문), 비밀값은 wo_out_ 앞머리', () => {
    const { secret, prefix } = generateOutboundSecret();
    expect(secret.startsWith('wo_out_')).toBe(true);
    expect(prefix).toBe(secret.slice(0, 12));
    expect(signOutbound('s3cret', '1700000000', '{"a":1}')).toBe(`sha256=${createHmac('sha256', 's3cret').update('1700000000.{"a":1}').digest('hex')}`);
  });

  it('몸에는 결과 글과 식별자만 — 길면 자르고 truncated', () => {
    const body = JSON.parse(buildOutboundPayload({ deliveryId: 'd1', sentAt: 't', app: { id: 'a', name: '앱' }, run: { messageId: 'm', conversationId: 'c', completedAt: 'z' }, text: '결과' }));
    expect(body).toEqual({ event: 'app.run.completed', delivery_id: 'd1', sent_at: 't', app: { id: 'a', name: '앱' }, run: { message_id: 'm', conversation_id: 'c', completed_at: 'z' }, result: { text: '결과', truncated: false } });
    const long = JSON.parse(buildOutboundPayload({ deliveryId: 'd', sentAt: 't', app: { id: 'a', name: 'n' }, run: { messageId: 'm', conversationId: 'c', completedAt: 'z' }, text: 'x'.repeat(OUTBOUND_TEXT_MAX + 5) }));
    expect(long.result.text).toHaveLength(OUTBOUND_TEXT_MAX);
    expect(long.result.truncated).toBe(true);
  });

  it('응답 판정 — 2xx 보냄 · 3xx·4xx 그만둠 · 408·429·5xx 다시', () => {
    expect(outcomeForStatus(204)).toEqual({ kind: 'sent', status: 204 });
    expect(outcomeForStatus(302)).toMatchObject({ kind: 'give_up' });
    expect(outcomeForStatus(401)).toMatchObject({ kind: 'give_up' });
    expect(outcomeForStatus(408)).toMatchObject({ kind: 'retry' });
    expect(outcomeForStatus(429)).toMatchObject({ kind: 'retry' });
    expect(outcomeForStatus(503)).toMatchObject({ kind: 'retry' });
  });

  it('다시 보낼 때 — 1·5·30분·2시간, 5번째 실패면 그만둠', () => {
    expect(OUTBOUND_MAX_ATTEMPTS).toBe(5);
    expect([1, 2, 3, 4].map((n) => nextAttemptAt(n, 0))).toEqual(OUTBOUND_BACKOFF_MS);
    expect(nextAttemptAt(5, 0)).toBeNull();
  });

  it('한 번 보내기 — 리다이렉트는 따르지 않고(manual) 몸은 버리며, 연결 실패·시간 초과는 다시', async () => {
    const cancel = vi.fn(async () => {});
    const fetchImpl = vi.fn(async (_url: string, _init: RequestInit) => ({ status: 200, body: { cancel } }));
    expect(await postOnce('https://h.example.com', { a: 'b' }, '{}', fetchImpl)).toEqual({ kind: 'sent', status: 200 });
    expect(fetchImpl.mock.calls[0][1]).toMatchObject({ method: 'POST', redirect: 'manual', body: '{}' });
    expect(cancel).toHaveBeenCalled();
    expect(await postOnce('https://h.example.com', {}, '{}', async () => { throw new Error('ECONNREFUSED'); })).toMatchObject({ kind: 'retry', status: null });
    const timeout = Object.assign(new Error('t'), { name: 'TimeoutError' });
    expect(await postOnce('https://h.example.com', {}, '{}', async () => { throw timeout; }, 8000)).toMatchObject({ kind: 'retry', error: expect.stringContaining('8초') });
  });

  it('보낼지 — 끝까지 마친 실행(멈춘 단계 없음)·글 있음·저장됨·시험 판 아님·보낼 곳 있음', () => {
    const base = { endpointId: 'e', draft: false, saved: true, text: '결과', steps: [{ status: 'completed' }, { status: 'skipped' }] };
    expect(shouldDeliver(base)).toBe(true);
    expect(shouldDeliver({ ...base, steps: [] })).toBe(true);
    expect(shouldDeliver({ ...base, endpointId: undefined })).toBe(false);
    expect(shouldDeliver({ ...base, draft: true })).toBe(false);
    expect(shouldDeliver({ ...base, saved: false })).toBe(false);
    expect(shouldDeliver({ ...base, text: '  ' })).toBe(false);
    expect(shouldDeliver({ ...base, steps: [{ status: 'completed' }, { status: 'failed' }] })).toBe(false);
  });
});

describe('보내기 실행기', () => {
  const row = (over: Partial<DueDelivery> = {}): DueDelivery => ({ id: 'd1', organization_id: 'o1', endpoint_id: 'e1', agent_id: 'a1', message_id: 'm1', status: 'pending', attempts: 0, claimed_at: null, ...over });
  const ctx = (over: Partial<DeliveryContext> = {}): DeliveryContext => ({
    endpoint: { url: 'https://hook.example.com/in', secret_encrypted: 'enc', organization_id: 'o1', revoked_at: null },
    message: { content: '최종 결과', conversation_id: 'c1', created_at: '2026-11-09T05:00:00Z', role: 'assistant' },
    agent: { id: 'a1', name: '법령 근거 조사' }, ...over,
  });
  function deps(over: Partial<OutboundDeps> & { rows?: DueDelivery[]; context?: DeliveryContext | null } = {}) {
    const finished: Array<{ id: string; patch: FinishPatch }> = [];
    const posted: Array<{ url: string; headers: Record<string, string>; body: string }> = [];
    let t = Date.parse('2026-11-09T06:00:00Z');
    const d: OutboundDeps = {
      now: () => t,
      listDue: async () => over.rows ?? [row()],
      claim: async () => true,
      load: async () => (over.context === undefined ? ctx() : over.context),
      finish: async (id, patch) => { finished.push({ id, patch }); },
      decrypt: () => 's3cret',
      checkHost: async () => ({ ok: true }),
      post: async (url, headers, body) => { posted.push({ url, headers, body }); return { kind: 'sent', status: 200 }; },
      log: async () => {},
      ...over,
    };
    return { d, finished, posted, advance: (ms: number) => { t += ms; } };
  }

  it('보내면 sent — 서명 머리글이 본문과 맞고, 같은 기록 id가 멱등 열쇠', async () => {
    const { d, finished, posted } = deps();
    expect(await dispatchDueDeliveries(d)).toEqual({ claimed: 1, sent: 1, retried: 0, gaveUp: 0, expired: 0 });
    const p = posted[0];
    expect(p.url).toBe('https://hook.example.com/in');
    expect(p.headers[OUTBOUND_HEADERS.delivery]).toBe('d1');
    expect(p.headers[OUTBOUND_HEADERS.idempotency]).toBe('d1');
    expect(p.headers[OUTBOUND_HEADERS.signature]).toBe(signOutbound('s3cret', p.headers[OUTBOUND_HEADERS.timestamp], p.body));
    expect(JSON.parse(p.body).result.text).toBe('최종 결과');
    expect(finished[0].patch).toMatchObject({ status: 'sent', attempts: 1, last_status: 200, last_error: null });
  });

  it('실패하면 다음 시각에 다시, 5번째 실패면 그만둠', async () => {
    const retry = deps({ post: async () => ({ kind: 'retry', status: 503, error: '503' }) });
    await dispatchDueDeliveries(retry.d);
    expect(retry.finished[0].patch).toMatchObject({ status: 'pending', attempts: 1, last_status: 503, next_attempt_at: new Date(Date.parse('2026-11-09T06:00:00Z') + 60_000).toISOString() });
    const last = deps({ rows: [row({ attempts: 4 })], post: async () => ({ kind: 'retry', status: 500, error: '500' }) });
    await dispatchDueDeliveries(last.d);
    expect(last.finished[0].patch).toMatchObject({ status: 'gave_up', attempts: 5, last_error: expect.stringContaining('5번 시도') });
    const rejected = deps({ post: async () => ({ kind: 'give_up', status: 401, error: '401' }) });
    await dispatchDueDeliveries(rejected.d);
    expect(rejected.finished[0].patch).toMatchObject({ status: 'gave_up', attempts: 1, last_status: 401 });
  });

  it('보내기 전에 다시 본다 — 회수·다른 기관·결과 없음·비밀값 못 읽음·사설 주소면 보내지 않고 그만둠', async () => {
    const cases: Array<Partial<OutboundDeps> & { context?: DeliveryContext | null }> = [
      { context: ctx({ endpoint: { ...ctx().endpoint!, revoked_at: '2026-11-09T00:00:00Z' } }) },
      { context: ctx({ endpoint: { ...ctx().endpoint!, organization_id: 'o2' } }) },
      { context: ctx({ endpoint: null }) },
      { context: ctx({ message: null }) },
      { context: ctx({ message: { ...ctx().message!, role: 'user' } }) },
      { decrypt: () => '' },
      { checkHost: async () => ({ ok: false, retry: false, message: '내부망' }) },
      { context: ctx({ endpoint: { ...ctx().endpoint!, url: 'http://hook.example.com' } }) },
    ];
    for (const c of cases) {
      const t = deps(c);
      await dispatchDueDeliveries(t.d);
      expect(t.posted).toHaveLength(0);
      expect(t.finished[0].patch.status).toBe('gave_up');
    }
    // 주소를 못 풀면 다시
    const dns = deps({ checkHost: async () => ({ ok: false, retry: true, message: 'DNS' }) });
    await dispatchDueDeliveries(dns.d);
    expect(dns.finished[0].patch).toMatchObject({ status: 'pending', attempts: 1 });
  });

  it('차지 못 한 기록은 건너뛰고, 읽기 실패는 시도 수를 세지 않고 다음 차례, 시간 예산을 넘으면 멈춤', async () => {
    const notMine = deps({ claim: async () => false });
    expect(await dispatchDueDeliveries(notMine.d)).toEqual({ claimed: 0, sent: 0, retried: 0, gaveUp: 0, expired: 0 });
    const unread = deps({ context: null });
    await dispatchDueDeliveries(unread.d);
    expect(unread.finished[0].patch).toMatchObject({ status: 'pending', attempts: 0 });
    const slow = deps({ rows: [row({ id: 'd1' }), row({ id: 'd2' })] });
    slow.d.post = async (url, headers, body) => { slow.advance(30_000); slow.posted.push({ url, headers, body }); return { kind: 'sent', status: 200 }; };
    const r = await dispatchDueDeliveries(slow.d, { budgetMs: 10_000 });
    expect(r.sent).toBe(1);
    // 목록을 못 읽어도 던지지 않는다
    expect(await dispatchDueDeliveries({ ...deps().d, listDue: async () => { throw new Error('db'); } })).toEqual({ claimed: 0, sent: 0, retried: 0, gaveUp: 0, expired: 0 });
  });
});

describe('연결', () => {
  it('앱 정의 — 보낼 곳은 uuid만, 소문자로', () => {
    const def = (deliverEndpointId: unknown) => validateAppDefinition({ schemaVersion: 1, fields: [{ key: 'topic', label: '주제', type: 'text', required: true }], output: 'bullets', deliverEndpointId });
    const ok = def('AAAAAAAA-1111-4111-8111-111111111111');
    expect(ok.ok && ok.value?.deliverEndpointId).toBe('aaaaaaaa-1111-4111-8111-111111111111');
    expect(def('x')).toMatchObject({ ok: false });
    const none = def(undefined);
    expect(none.ok && none.value).not.toHaveProperty("deliverEndpointId");
  });

  it('시험 판 실행은 보내지 않고, 실행이 끝난 뒤 저장한 답변 id로 넣는다 — 실행기는 예약 실행과 나란히', () => {
    const prepare = readFileSync('src/lib/assistant/prepare.ts', 'utf8');
    expect(prepare).toContain('appStepInputs && !appDraftSavedAt && definition.value?.deliverEndpointId');
    const stream = readFileSync('src/lib/assistant/stream.ts', 'utf8');
    const save = stream.indexOf('const saveError = await saveMessages(');
    const enqueue = stream.indexOf('enqueueOutbound)({');
    expect(save).toBeGreaterThan(0);
    expect(enqueue).toBeGreaterThan(save);
    expect(stream.slice(enqueue, enqueue + 300)).toContain('messageId: messageIds.assistant');
    const cron = readFileSync('src/app/api/cron/app-schedules/route.ts', 'utf8');
    expect(cron).toMatch(/Promise\.all\(\[\s*dispatchDueDeliveries/);
  });

  it('관리는 기관 전체 관리자만 — 직원 목록은 이름만', () => {
    const actor = (over: Partial<ActorScope>): ActorScope => ({ userId: 'u', isAdmin: true, departmentId: 'd', organizationId: 'o', visibleDepartmentIds: ['d'], managedDepartmentIds: ['d'], managesWholeOrganization: true, ...over });
    expect(wholeOrgAdminProblem(actor({}))).toBeNull();
    expect(wholeOrgAdminProblem(actor({ managesWholeOrganization: false }))).toMatchObject({ status: 403 });
    expect(wholeOrgAdminProblem(actor({ isAdmin: false }))).toMatchObject({ status: 403 });
    expect(wholeOrgAdminProblem(null)).toMatchObject({ status: 403 });
    const admin = readFileSync('src/lib/apps/outbound/admin.ts', 'utf8');
    expect(admin).toMatch(/from\('app_outbound_endpoints'\)\.select\('id, name, require_approval'\)/);
    expect(readFileSync('src/app/api/apps/outbound-endpoints/route.ts', 'utf8')).not.toMatch(/secret|url:/);
    // 화면 모듈은 서버 코드를 가져오지 않는다
    expect(readFileSync('src/lib/apps/outbound/spec.ts', 'utf8')).not.toMatch(/^import /m);
    expect(readFileSync('src/components/admin/OutboundEndpointsPanel.tsx', 'utf8')).not.toMatch(/outbound\/(deliver|admin)/);
  });
});
