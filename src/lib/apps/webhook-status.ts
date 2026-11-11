/**
 * 비동기 연동 호출의 묶음 상태 묻기(0087) — `GET /api/apps/webhook/batches/[id]`.
 * 외부 시스템이 202로 받은 `batch_id`를 같은 연동 토큰(Bearer)으로 묻는다. **그 연동이 넣은 묶음만** 보인다(`app_batches.webhook_id`) —
 * 다른 연동·손으로 만든 묶음·없는 번호는 모두 같은 404(있는지 알리지 않음). 상태·대화 id·오류 안내·결과 보내기 상태만 돌려주고
 * **결과 글·입력값은 싣지 않는다**(결과는 기관이 승인한 '결과 보낼 곳'으로만 나간다). 묻기는 실행이 아니라 간격·하루 상한·사용 횟수를 쓰지 않는다.
 * 기관이 외부 연동을 꺼 두었으면(0068) 묻기도 403 — 연동을 끈 동안 바깥과 주고받지 않는다.
 */
import { supabaseAdmin } from '@/lib/supabaseAdmin';
import { WEBHOOK_ORG_DISABLED, bearerWebhookToken } from './webhook-spec';
import { hashWebhookToken, WEBHOOK_INVALID_TOKEN, type WebhookResponse } from './webhooks';
import { tokenOrgWebhooksDisabled } from './webhook-switch';

export const WEBHOOK_BATCH_NOT_FOUND = '이 연동으로 넣은 실행을 찾지 못했습니다.';

export type WebhookRunState = 'queued' | 'running' | 'completed' | 'failed' | 'stopped' | 'cancelled';

export type StatusBatchRow = { id: string; status: string; stop_reason: string | null; created_at: string; finished_at: string | null };
export type StatusItemRow = { status: string; conversation_id: string | null; message_id: string | null; error: string | null; finished_at: string | null } | null;
export type StatusDeliveryRow = { status: string; receipt_ref: string | null } | null;

export interface WebhookStatusDeps {
  /** 쓸 수 있는 토큰(활성·안 만료)의 연동 id — 아니면 null */
  findWebhook(tokenHash: string, nowMs: number): Promise<{ id: string } | null>;
  orgDisabled(tokenHash: string, nowMs: number): Promise<boolean>;
  /** 그 연동이 넣은 묶음(`webhook_id`가 같을 때만)과 그 줄, 결과 보내기 기록 */
  loadBatch(batchId: string, webhookId: string): Promise<{ batch: StatusBatchRow; item: StatusItemRow; delivery: StatusDeliveryRow } | null>;
  now(): number;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** 한 줄 묶음의 상태를 외부에 보이는 꼴로 — 묶음이 멈춤·그만둠이면 그것이 먼저, 아니면 줄의 상태 */
export function webhookRunState(batch: Pick<StatusBatchRow, 'status'>, item: StatusItemRow): WebhookRunState {
  if (batch.status === 'stopped') return 'stopped';
  if (batch.status === 'cancelled') return 'cancelled';
  if (item?.status === 'done') return 'completed';
  if (item?.status === 'failed') return 'failed';
  if (item?.status === 'skipped') return 'stopped';
  if (item?.status === 'running') return 'running';
  return 'queued';
}

/** 결과 보내기 상태 — 외부에는 넷으로: 기다림(확인 기다림 포함)·보냄·그만둠·보내지 않기로 함 */
export function deliveryState(row: StatusDeliveryRow): { status: 'pending' | 'awaiting_approval' | 'sent' | 'gave_up' | 'rejected'; receipt_reference: string | null } | null {
  if (!row) return null;
  const status = row.status === 'sending' ? 'pending'
    : (['pending', 'awaiting_approval', 'sent', 'gave_up', 'rejected'] as const).find((s) => s === row.status) ?? 'pending';
  return { status, receipt_reference: status === 'sent' ? row.receipt_ref : null };
}

const fail = (status: number, message: string): WebhookResponse => ({ status, body: { ok: false, error: { message } } });

export async function handleWebhookBatchStatus(deps: WebhookStatusDeps, request: { authorization: string | null; batchId: string }): Promise<WebhookResponse> {
  const token = bearerWebhookToken(request.authorization);
  if (!token) return fail(401, WEBHOOK_INVALID_TOKEN);
  const hash = hashWebhookToken(token);
  const webhook = await deps.findWebhook(hash, deps.now());
  if (!webhook) return fail(401, WEBHOOK_INVALID_TOKEN);
  if (await deps.orgDisabled(hash, deps.now())) return fail(403, WEBHOOK_ORG_DISABLED);
  if (!UUID.test(request.batchId)) return fail(404, WEBHOOK_BATCH_NOT_FOUND);
  const found = await deps.loadBatch(request.batchId.toLowerCase(), webhook.id);
  if (!found) return fail(404, WEBHOOK_BATCH_NOT_FOUND);
  const state = webhookRunState(found.batch, found.item);
  const error = state === 'failed' ? found.item?.error ?? '실행하지 못했습니다.'
    : state === 'stopped' ? found.batch.stop_reason ?? found.item?.error ?? '실행이 멈췄습니다.'
    : null;
  return {
    status: 200,
    headers: { 'Cache-Control': 'no-store' },
    body: { ok: true, data: {
      batch_id: found.batch.id,
      status: state,
      conversation_id: state === 'completed' || state === 'failed' ? found.item?.conversation_id ?? null : null,
      error,
      accepted_at: found.batch.created_at,
      finished_at: found.item?.finished_at ?? found.batch.finished_at,
      delivery: deliveryState(found.delivery),
    } },
  };
}

export function webhookStatusDeps(): WebhookStatusDeps {
  return {
    async findWebhook(tokenHash, nowMs) {
      const { data, error } = await supabaseAdmin.from('app_webhooks').select('id')
        .eq('token_hash', tokenHash).eq('status', 'active').gt('expires_at', new Date(nowMs).toISOString()).maybeSingle();
      if (error) throw new Error(`app_webhooks status: ${error.message}`);
      return (data as { id: string } | null) ?? null;
    },
    orgDisabled: tokenOrgWebhooksDisabled,
    async loadBatch(batchId, webhookId) {
      const { data: batch, error } = await supabaseAdmin.from('app_batches').select('id, status, stop_reason, created_at, finished_at')
        .eq('id', batchId).eq('webhook_id', webhookId).eq('source', 'webhook').maybeSingle();
      if (error) throw new Error(`app_batches status: ${error.message}`);
      if (!batch) return null;
      const { data: item, error: itemError } = await supabaseAdmin.from('app_batch_items').select('status, conversation_id, message_id, error, finished_at')
        .eq('batch_id', batchId).order('position', { ascending: true }).limit(1).maybeSingle();
      if (itemError) throw new Error(`app_batch_items status: ${itemError.message}`);
      const messageId = (item as { message_id?: string | null } | null)?.message_id ?? null;
      let delivery: StatusDeliveryRow = null;
      if (messageId) {
        const { data: d, error: dError } = await supabaseAdmin.from('app_outbound_deliveries').select('status, receipt_ref')
          .eq('message_id', messageId).order('created_at', { ascending: true }).limit(1).maybeSingle();
        if (dError) throw new Error(`app_outbound_deliveries status: ${dError.message}`);
        delivery = (d as StatusDeliveryRow) ?? null;
      }
      return { batch: batch as StatusBatchRow, item: (item as StatusItemRow) ?? null, delivery };
    },
    now: () => Date.now(),
  };
}
