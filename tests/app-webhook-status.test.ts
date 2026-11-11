import { describe, expect, it, vi, beforeAll, afterAll } from 'vitest';
import { readFileSync } from 'node:fs';
import pg from 'pg';

vi.mock('@/lib/supabaseAdmin', () => ({ supabaseAdmin: {} }));
vi.mock('@/lib/logger', () => ({ logSystem: vi.fn() }));

import { deliveryState, handleWebhookBatchStatus, webhookRunState, WEBHOOK_BATCH_NOT_FOUND, type WebhookStatusDeps } from '@/lib/apps/webhook-status';
import { hashWebhookToken, WEBHOOK_INVALID_TOKEN } from '@/lib/apps/webhooks';
import { WEBHOOK_ORG_DISABLED } from '@/lib/apps/webhook-spec';

const TOKEN = 'wo_wh_' + 'a'.repeat(43);
const BATCH = '11111111-2222-4333-8444-555555555555';
const batchRow = { id: BATCH, status: 'running', stop_reason: null, created_at: '2026-11-11T01:00:00Z', finished_at: null };

function deps(over: Partial<WebhookStatusDeps> = {}): WebhookStatusDeps {
  return {
    findWebhook: vi.fn(async () => ({ id: 'w1' })),
    orgDisabled: vi.fn(async () => false),
    loadBatch: vi.fn(async () => ({ batch: batchRow, item: { status: 'pending', conversation_id: null, message_id: null, error: null, finished_at: null }, delivery: null })),
    now: () => Date.parse('2026-11-11T02:00:00Z'),
    ...over,
  };
}
const call = (d: WebhookStatusDeps, auth: string | null = `Bearer ${TOKEN}`, batchId = BATCH) => handleWebhookBatchStatus(d, { authorization: auth, batchId });

describe('비동기 연동 묶음 상태 묻기', () => {
  it('상태 꼴 — 묶음 멈춤·그만둠이 먼저, 아니면 줄', () => {
    expect(webhookRunState({ status: 'running' }, { status: 'pending', conversation_id: null, message_id: null, error: null, finished_at: null })).toBe('queued');
    expect(webhookRunState({ status: 'running' }, null)).toBe('queued');
    expect(webhookRunState({ status: 'running' }, { status: 'running', conversation_id: null, message_id: null, error: null, finished_at: null })).toBe('running');
    expect(webhookRunState({ status: 'done' }, { status: 'done', conversation_id: 'c', message_id: 'm', error: null, finished_at: 'x' })).toBe('completed');
    expect(webhookRunState({ status: 'done' }, { status: 'failed', conversation_id: 'c', message_id: null, error: 'e', finished_at: 'x' })).toBe('failed');
    expect(webhookRunState({ status: 'stopped' }, { status: 'skipped', conversation_id: null, message_id: null, error: null, finished_at: 'x' })).toBe('stopped');
    expect(webhookRunState({ status: 'cancelled' }, { status: 'pending', conversation_id: null, message_id: null, error: null, finished_at: null })).toBe('cancelled');
  });
  it('보내기 상태 — 보내는 중은 기다림, 접수 번호는 보냈을 때만', () => {
    expect(deliveryState(null)).toBeNull();
    expect(deliveryState({ status: 'sending', receipt_ref: null })).toEqual({ status: 'pending', receipt_reference: null });
    expect(deliveryState({ status: 'sent', receipt_ref: 'R-1' })).toEqual({ status: 'sent', receipt_reference: 'R-1' });
    expect(deliveryState({ status: 'awaiting_approval', receipt_ref: null })).toEqual({ status: 'awaiting_approval', receipt_reference: null });
    expect(deliveryState({ status: 'gave_up', receipt_ref: 'X' })).toEqual({ status: 'gave_up', receipt_reference: null });
  });
  it('기다리는 중 — 200·no-store, 결과 글·입력값 없음', async () => {
    const d = deps();
    const r = await call(d);
    expect(r.status).toBe(200);
    expect(r.headers).toEqual({ 'Cache-Control': 'no-store' });
    expect(r.body).toEqual({ ok: true, data: { batch_id: BATCH, status: 'queued', conversation_id: null, error: null, accepted_at: '2026-11-11T01:00:00Z', finished_at: null, delivery: null } });
    expect(d.findWebhook).toHaveBeenCalledWith(hashWebhookToken(TOKEN), expect.any(Number));
    expect(d.loadBatch).toHaveBeenCalledWith(BATCH, 'w1');
  });
  it('마침 — 대화 id·보내기 상태', async () => {
    const r = await call(deps({ loadBatch: async () => ({ batch: { ...batchRow, status: 'done', finished_at: '2026-11-11T01:06:00Z' }, item: { status: 'done', conversation_id: 'c1', message_id: 'm1', error: null, finished_at: '2026-11-11T01:05:00Z' }, delivery: { status: 'sent', receipt_ref: 'R-7' } }) }));
    expect(r.body).toMatchObject({ data: { status: 'completed', conversation_id: 'c1', error: null, finished_at: '2026-11-11T01:05:00Z', delivery: { status: 'sent', receipt_reference: 'R-7' } } });
  });
  it('실패·멈춤 — 오류 안내', async () => {
    const failed = await call(deps({ loadBatch: async () => ({ batch: { ...batchRow, status: 'done' }, item: { status: 'failed', conversation_id: 'c2', message_id: null, error: '입력이 틀렸습니다.', finished_at: 'x' }, delivery: null }) }));
    expect(failed.body).toMatchObject({ data: { status: 'failed', conversation_id: 'c2', error: '입력이 틀렸습니다.' } });
    const stopped = await call(deps({ loadBatch: async () => ({ batch: { ...batchRow, status: 'stopped', stop_reason: '앱 설정이 바뀌었습니다.' }, item: { status: 'skipped', conversation_id: null, message_id: null, error: null, finished_at: 'x' }, delivery: null }) }));
    expect(stopped.body).toMatchObject({ data: { status: 'stopped', conversation_id: null, error: '앱 설정이 바뀌었습니다.' } });
  });
  it('토큰이 없거나 쓸 수 없으면 401, 기관이 끄면 403', async () => {
    expect((await call(deps(), null)).status).toBe(401);
    const d = deps({ findWebhook: vi.fn(async () => null) });
    const r = await call(d);
    expect(r).toEqual({ status: 401, body: { ok: false, error: { message: WEBHOOK_INVALID_TOKEN } } });
    expect(d.loadBatch).not.toHaveBeenCalled();
    const off = deps({ orgDisabled: vi.fn(async () => true) });
    expect(await call(off)).toEqual({ status: 403, body: { ok: false, error: { message: WEBHOOK_ORG_DISABLED } } });
    expect(off.loadBatch).not.toHaveBeenCalled();
  });
  it('다른 연동의 묶음·없는 번호·꼴이 틀린 번호는 같은 404', async () => {
    const d = deps({ loadBatch: vi.fn(async () => null) });
    expect(await call(d)).toEqual({ status: 404, body: { ok: false, error: { message: WEBHOOK_BATCH_NOT_FOUND } } });
    const bad = deps();
    expect((await call(bad, `Bearer ${TOKEN}`, 'not-a-uuid')).status).toBe(404);
    expect(bad.loadBatch).not.toHaveBeenCalled();
  });
  it('연결(원본) — 넣기가 연동 id를 묶음에 남기고, 조회는 그 연동·source=webhook만, 라우트는 공개 목록에', () => {
    expect(readFileSync('src/lib/apps/webhooks.ts', 'utf8')).toContain("{ source: 'webhook', appVersion: w.app_version, webhookId: w.id }");
    expect(readFileSync('src/lib/apps/batches.ts', 'utf8')).toContain("...(opts.source === 'webhook' && opts.webhookId ? { webhook_id: opts.webhookId } : {})");
    const status = readFileSync('src/lib/apps/webhook-status.ts', 'utf8');
    expect(status).toContain(".eq('id', batchId).eq('webhook_id', webhookId).eq('source', 'webhook')");
    expect(status).not.toMatch(/select\([^)]*inputs/);
    expect(readFileSync('src/app/api/apps/webhook/batches/[id]/route.ts', 'utf8')).toContain('handleWebhookBatchStatus(webhookStatusDeps()');
  });
});

const url = process.env.WORK_TEST_DATABASE_URL;
describe.skipIf(!url)('묶음의 연동 id (0087, 시험 DB)', () => {
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
  it('webhook_id는 연동을 가리키고(지우면 비움) source=webhook에만, 색인', async () => {
    const fk = await db.query("SELECT pg_get_constraintdef(c.oid) d FROM pg_constraint c JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = ANY(c.conkey) WHERE c.conrelid = 'public.app_batches'::regclass AND c.contype = 'f' AND a.attname = 'webhook_id'");
    expect(fk.rows).toHaveLength(1);
    expect(fk.rows[0].d).toContain('app_webhooks(id) ON DELETE SET NULL');
    const chk = await db.query("SELECT pg_get_constraintdef(oid) d FROM pg_constraint WHERE conname = 'app_batches_webhook_source_check'");
    expect(chk.rows).toHaveLength(1);
    expect(chk.rows[0].d).toContain("source = 'webhook'");
    const idx = await db.query("SELECT indexdef FROM pg_indexes WHERE indexname = 'app_batches_webhook_idx'");
    expect(idx.rows[0].indexdef).toContain('(webhook_id)');
  });
});
