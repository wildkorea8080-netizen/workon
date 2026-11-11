import { readFileSync } from 'fs';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import pg from 'pg';
import { WEBHOOK_ASYNC_BUSY, WEBHOOK_ASYNC_NO_DOCUMENTS, WEBHOOK_ASYNC_NO_FILES, wantsAsync } from '@/lib/apps/webhook-spec';
import {
  REPLAYED_HEADER, WEBHOOK_APP_CHANGED, WEBHOOK_DEPARTMENT_CHANGED, WEBHOOK_USER_UNAVAILABLE,
  enqueueWebhookRun, generateWebhookToken, handleWebhookCall, type ClaimResult, type EnqueueWebhookIo, type WebhookDeps, type WebhookEnqueueOutcome,
} from '@/lib/apps/webhooks';
import { BATCH_APP_VERSION_CHANGED } from '@/lib/apps/batch-spec';
import { notifyBatchFinished, type BatchNoticeFacts, type BatchNoticeIo } from '@/lib/apps/batches';
import { buildOutboundPayload } from '@/lib/apps/outbound/spec';
import type { ActorScope } from '@/lib/agent-permissions';

/**
 * (2026-11-11, 0087) 외부 연동의 비동기 호출 — `"async": true`·`Prefer: respond-async`면 202와 묶음 번호, 그 직원의 한 줄 일괄 실행으로.
 * 결과는 앱의 결과 보낼 곳으로(몸의 run.batch_id), 마침 메일 없음, 파일·문서함 문서는 받지 않음, 기다리는 호출과 같은 문턱(계정·부서·앱 판)
 */
const token = generateWebhookToken();
const claimed = { id: 'w1', agent_id: 'a1', user_id: 'u1', department_id: 'd1', organization_id: 'o1', app_version: 3 };
const BATCH = 'bbbbbbbb-1111-4111-8111-111111111111';

function deps(queued: WebhookEnqueueOutcome | Error = { kind: 'accepted', batchId: BATCH, resultDelivery: true }, claim: ClaimResult = { ok: true, webhook: claimed, call_id: 'call1' }) {
  return {
    orgDisabled: vi.fn<WebhookDeps['orgDisabled']>(async () => false),
    claim: vi.fn<WebhookDeps['claim']>(async () => claim),
    execute: vi.fn<WebhookDeps['execute']>(async () => ({ kind: 'completed', conversationId: 'c1' })),
    enqueue: vi.fn<NonNullable<WebhookDeps['enqueue']>>(async () => { if (queued instanceof Error) throw queued; return queued; }),
    finish: vi.fn<WebhookDeps['finish']>(async () => {}), recordCall: vi.fn<WebhookDeps['recordCall']>(async () => {}), log: vi.fn<WebhookDeps['log']>(async () => {}), now: vi.fn<WebhookDeps['now']>(() => Date.parse('2026-11-11T00:00:00Z')),
  } satisfies WebhookDeps;
}
const call = (d: WebhookDeps, body: unknown = { inputs: { title: '주간 보고' }, async: true }, extra: { prefer?: string; key?: string } = {}) =>
  handleWebhookCall(d, { authorization: `Bearer ${token.token}`, bodyText: JSON.stringify(body), idempotencyKey: extra.key ?? null, prefer: extra.prefer ?? null });

describe('비동기를 고르는 법(wantsAsync)', () => {
  it('본문 async: true 또는 Prefer: respond-async만', () => {
    expect(wantsAsync(true, null)).toBe(true);
    expect(wantsAsync(undefined, 'respond-async')).toBe(true);
    expect(wantsAsync(undefined, 'return=minimal, respond-async, wait=10')).toBe(true);
    expect(wantsAsync('true', null)).toBe(false);
    expect(wantsAsync(1, null)).toBe(false);
    expect(wantsAsync(undefined, 'respond-asynchronously')).toBe(false);
    expect(wantsAsync(undefined, null)).toBe(false);
  });
});

describe('비동기 호출 처리', () => {
  it('202와 묶음 번호·결과 보낼 곳 유무 — 앱을 기다리지 않고(execute 없음), 기록은 202와 묶음 번호, 연동 상태는 건드리지 않음', async () => {
    const d = deps();
    const res = await call(d);
    expect(res).toEqual({ status: 202, body: { ok: true, data: { status: 'accepted', batch_id: BATCH, result_delivery: true } } });
    expect(d.enqueue).toHaveBeenCalledWith(claimed, { title: '주간 보고' });
    expect(d.execute).not.toHaveBeenCalled();
    expect(d.finish).not.toHaveBeenCalled();
    expect(d.recordCall).toHaveBeenCalledWith('call1', { http_status: 202, message: BATCH, conversation_id: null });
  });
  it('Prefer 머리글로도 비동기, 머리글·본문 둘 다 없으면 기다리는 호출', async () => {
    const d = deps();
    expect((await call(d, { inputs: { title: 'x' } }, { prefer: 'respond-async' })).status).toBe(202);
    const e = deps();
    expect((await call(e, { inputs: { title: 'x' } })).status).toBe(200);
    expect(e.enqueue).not.toHaveBeenCalled();
    expect(e.execute).toHaveBeenCalled();
  });
  it('파일과 함께면 차지 전에 400', async () => {
    const d = deps();
    const res = await call(d, { inputs: {}, async: true, files: [{ name: 'a.txt', content_base64: Buffer.from('hi').toString('base64') }] });
    expect(res).toMatchObject({ status: 400, body: { error: { message: WEBHOOK_ASYNC_NO_FILES } } });
    expect(d.claim).not.toHaveBeenCalled();
  });
  it('같은 키로 기다리는 호출과 비동기를 섞으면 다른 요청(요청 해시가 다름)', async () => {
    const d = deps();
    await call(d, { inputs: { title: 'x' }, async: true }, { key: 'k-1' });
    await call(d, { inputs: { title: 'x' } }, { key: 'k-1' });
    const hashes = d.claim.mock.calls.map((c) => c[2]?.requestHash);
    expect(hashes[0]).toMatch(/^[0-9a-f]{64}$/);
    expect(hashes[0]).not.toBe(hashes[1]);
  });
  it('같은 키 다시 보내기 — 처음 받은 묶음 번호 그대로(202)', async () => {
    const d = deps(undefined, { ok: false, reason: 'replay', call: { http_status: 202, conversation_id: null, message: BATCH } });
    expect(await call(d, undefined, { key: 'k-1' })).toEqual({ status: 202, body: { ok: true, data: { status: 'accepted', batch_id: BATCH, replayed: true } }, headers: { [REPLAYED_HEADER]: 'true' } });
  });
  it('넣지 못한 이유를 기다리는 호출과 같은 상태·안내로 — 429·5xx는 기록하지 않음', async () => {
    const cases: Array<[WebhookEnqueueOutcome | Error, number, string, boolean]> = [
      [{ kind: 'user_unavailable' }, 403, WEBHOOK_USER_UNAVAILABLE, true],
      [{ kind: 'department_changed' }, 403, WEBHOOK_DEPARTMENT_CHANGED, true],
      [{ kind: 'app_changed' }, 409, WEBHOOK_APP_CHANGED, true],
      [{ kind: 'rejected', status: 400, message: WEBHOOK_ASYNC_NO_DOCUMENTS }, 400, WEBHOOK_ASYNC_NO_DOCUMENTS, true],
      [{ kind: 'rejected', status: 429, message: WEBHOOK_ASYNC_BUSY }, 429, WEBHOOK_ASYNC_BUSY, false],
      [new Error('db down'), 500, '잠시 뒤 다시 보내 주세요.', false],
    ];
    for (const [queued, status, message, recorded] of cases) {
      const d = deps(queued);
      expect(await call(d)).toMatchObject({ status, body: { ok: false, error: { message } } });
      expect(d.recordCall).toHaveBeenCalledWith('call1', recorded ? { http_status: status, message, conversation_id: null } : null);
      expect(d.log).toHaveBeenCalled();
    }
  });
  it('넣는 길이 없으면 501', async () => {
    const d = deps();
    const { enqueue: _enqueue, ...rest } = d;
    expect((await call(rest)).status).toBe(501);
  });
});

describe('넣기(enqueueWebhookRun)', () => {
  const actor = { userId: 'u1', organizationId: 'o1', departmentId: 'd1' } as ActorScope;
  function io(over: Partial<EnqueueWebhookIo> = {}) {
    const createBatch = vi.fn<EnqueueWebhookIo['createBatch']>(async () => ({ ok: true, batchId: BATCH }));
    const value: EnqueueWebhookIo = {
      documentIdsOf: async () => [],
      loadUser: async () => ({ id: 'u1', role: 'USER', department_id: 'd1', is_active: true, deleted_at: null }),
      actorFor: async () => actor,
      appInfo: async () => ({ name: '민원 답변 앱', deliverEndpointId: 'e1' }),
      createBatch, ...over,
    };
    return { value, createBatch };
  }
  it('그 직원의 한 줄 일괄 실행 — 이름 [연동]·source webhook·연동이 박은 앱 판', async () => {
    const t = io();
    expect(await enqueueWebhookRun(claimed, { title: '주간' }, t.value)).toEqual({ kind: 'accepted', batchId: BATCH, resultDelivery: true });
    expect(t.createBatch).toHaveBeenCalledWith(actor, { agent_id: 'a1', name: '[연동] 민원 답변 앱', rows: [{ title: '주간' }] }, { source: 'webhook', appVersion: 3, webhookId: 'w1' });
    const u = io({ appInfo: async () => ({ name: '앱', deliverEndpointId: null }) });
    expect(await enqueueWebhookRun(claimed, {}, u.value)).toMatchObject({ resultDelivery: false });
  });
  it('문서함 문서 400·계정·부서·다른 기관·앱 없음·앱 판 바뀜·실행 중 많음 — 묶음을 만들지 않거나 그 이유로', async () => {
    const docs = io({ documentIdsOf: async () => ['d-1'] });
    expect(await enqueueWebhookRun(claimed, {}, docs.value)).toEqual({ kind: 'rejected', status: 400, message: WEBHOOK_ASYNC_NO_DOCUMENTS });
    expect(docs.createBatch).not.toHaveBeenCalled();
    expect(await enqueueWebhookRun(claimed, {}, io({ loadUser: async () => null }).value)).toEqual({ kind: 'user_unavailable' });
    expect(await enqueueWebhookRun(claimed, {}, io({ loadUser: async () => ({ id: 'u1', role: 'USER', department_id: 'd1', is_active: false, deleted_at: null }) }).value)).toEqual({ kind: 'user_unavailable' });
    expect(await enqueueWebhookRun(claimed, {}, io({ loadUser: async () => ({ id: 'u1', role: 'USER', department_id: 'd2', is_active: true, deleted_at: null }) }).value)).toEqual({ kind: 'department_changed' });
    expect(await enqueueWebhookRun(claimed, {}, io({ actorFor: async () => ({ ...actor, organizationId: 'o2' }) }).value)).toEqual({ kind: 'department_changed' });
    expect(await enqueueWebhookRun(claimed, {}, io({ appInfo: async () => null }).value)).toMatchObject({ kind: 'rejected', status: 404 });
    expect(await enqueueWebhookRun(claimed, {}, io({ createBatch: async () => ({ ok: false, status: 409, message: BATCH_APP_VERSION_CHANGED }) }).value)).toEqual({ kind: 'app_changed' });
    expect(await enqueueWebhookRun(claimed, {}, io({ createBatch: async () => ({ ok: false, status: 409, message: '실행 중인 일괄 실행은 3개까지입니다.' }) }).value)).toEqual({ kind: 'rejected', status: 429, message: WEBHOOK_ASYNC_BUSY });
    expect(await enqueueWebhookRun(claimed, {}, io({ createBatch: async () => ({ ok: false, status: 400, message: '제목은 필수입니다.' }) }).value)).toEqual({ kind: 'rejected', status: 400, message: '제목은 필수입니다.' });
  });
});

describe('결과 보내기·메일', () => {
  const base = { deliveryId: 'dl1', sentAt: '2026-11-11T00:00:00Z', app: { id: 'a1', name: '앱' }, run: { messageId: 'm1', conversationId: 'c1', completedAt: '2026-11-11T00:00:00Z' }, text: '결과' };
  it('일괄 실행의 결과면 몸에 run.batch_id, 아니면 예전과 같은 꼴', () => {
    expect(JSON.parse(buildOutboundPayload({ ...base, run: { ...base.run, batchId: BATCH } })).run).toEqual({ message_id: 'm1', conversation_id: 'c1', completed_at: '2026-11-11T00:00:00Z', batch_id: BATCH });
    expect(JSON.parse(buildOutboundPayload(base)).run).toEqual({ message_id: 'm1', conversation_id: 'c1', completed_at: '2026-11-11T00:00:00Z' });
  });
  it('비동기 연동이 만든 묶음은 마침 메일을 보내지 않는다', async () => {
    const facts: BatchNoticeFacts = { agentId: 'a1', appName: '앱', name: '[연동] 앱', status: 'done', stopReason: null, total: 1, finishedAt: null, done: 1, failed: 0, skipped: 0, awaitingApproval: 0, email: 'kim@example.go.kr', source: 'webhook' };
    const send = vi.fn<BatchNoticeIo['send']>(async () => ({ sent: true }));
    expect(await notifyBatchFinished('b1', { mailConfigured: () => true, load: async () => facts, send })).toBe(false);
    expect(send).not.toHaveBeenCalled();
    expect(await notifyBatchFinished('b1', { mailConfigured: () => true, load: async () => ({ ...facts, source: 'manual' }), send })).toBe(true);
  });
  it('연결(원본) — 만들기가 앱 판을 맞대고 source를 넣고, 보내기가 묶음 번호를 찾고, 라우트가 Prefer를 넘긴다', () => {
    const batches = readFileSync('src/lib/apps/batches.ts', 'utf8');
    expect(batches).toContain('opts.appVersion !== undefined && agent.version !== opts.appVersion');
    expect(batches).toContain("...(opts.source ? { source: opts.source } : {})");
    expect(batches).toContain("if (facts.source === 'webhook') return false;");
    expect(readFileSync('src/lib/apps/outbound/deliver.ts', 'utf8')).toContain(".from('app_batch_items').select('batch_id').eq('message_id', row.message_id)");
    expect(readFileSync('src/app/api/apps/webhook/route.ts', 'utf8')).toContain('prefer: request.headers.get(PREFER_HEADER)');
  });
});

const url = process.env.WORK_TEST_DATABASE_URL;
describe.skipIf(!url)('일괄 실행 source (0087, 시험 DB)', () => {
  let db: pg.Client;
  beforeAll(async () => {
    if (/supabase\.(co|com)|pooler\./.test(url!)) throw new Error('운영 DB 주소로 보입니다 — 시험 DB를 쓰세요');
    db = new pg.Client({ connectionString: url });
    await db.connect();
    const sql = readFileSync('supabase/migrations/0087_app_batch_source.sql', 'utf8');
    await db.query(sql);
    await db.query(sql);
  });
  afterAll(async () => { await db?.end(); });
  it('기본 manual, webhook은 받고 그 밖은 거절, 메시지 색인', async () => {
    const col = await db.query("SELECT column_default, is_nullable FROM information_schema.columns WHERE table_schema='public' AND table_name='app_batches' AND column_name='source'");
    expect(col.rows[0]).toEqual({ column_default: "'manual'::text", is_nullable: 'NO' });
    const con = await db.query("SELECT pg_get_constraintdef(oid) d FROM pg_constraint WHERE conname='app_batches_source_check'");
    expect(con.rows[0].d).toContain('manual');
    expect(con.rows[0].d).toContain('webhook');
    expect(con.rows).toHaveLength(1);
    const idx = await db.query("SELECT indexdef FROM pg_indexes WHERE indexname='app_batch_items_message_idx'");
    expect(idx.rows[0].indexdef).toContain('(message_id)');
  });
});
