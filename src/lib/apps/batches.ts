// src/lib/apps/batches.ts
// 입력형 앱 일괄 실행(0077) — 만들기·목록·그만두기·실행기·결과 엑셀(서버). 규칙은 batch-spec.ts.
//
// - 만들기: 직원이 쓸 수 있는 입력형 앱(파일이 꼭 필요한 앱은 빼고)에 줄마다 입력값을 앱 규칙(`renderAppInput`)으로 다시 검사해 저장한다.
//   한 사람에 실행 중 3개·한 번에 100줄. 앱 판·부서를 박아 두고, 실행 때 바뀌었으면 멈춘다(예약과 같은 판단).
// - 실행기: 앱 예약 실행기(pg_cron 5분)가 예약 실행과 나란히 부른다. 실행 중인 묶음의 줄을 만든 순서대로 조건부로 차지해
//   예약과 같은 `runAppAs`(그 직원의 세션 꼴 — 권한·한도·사용 기록이 손 실행과 같음)로 돌린다. 두 줄씩 나란히, 새 줄은 시작 90초 안에서만.
//   앱 변경·권한·계정·부서·한도 문제는 묶음을 멈추고(남은 줄은 건너뜀), 줄의 입력 문제는 그 줄만 실패, 모델 오류는 한 번 더 해 본다.
// - 결과: 줄마다 그 실행의 대화·답변 메시지를 가리킨다(결과 글을 따로 저장하지 않음). 엑셀은 입력·상태·결과 글·오류를 한 시트로(값만, 수식 주입 막음).
import { supabaseAdmin } from '@/lib/supabaseAdmin';
import type { ActorScope } from '@/lib/agent-permissions';
import { AGENT_ACCESS_COLUMNS, canUseAgent, type AgentAccessInfo } from '@/lib/agent-permissions';
import { renderAppInput, validateAppDefinition } from '@/lib/apps/definition';
import { defaultRunAsIo, runAppAs, type RunAsOutcome } from '@/lib/apps/run-as';
import { logSystem } from '@/lib/logger';
import { safeText } from '@/lib/xlsx-export';
import {
  BATCH_FILES_UNSUPPORTED, BATCH_ITEM_STATUS_LABELS, BATCH_MAX_ATTEMPTS, BATCH_MAX_ROWS, BATCH_MAX_RUNNING, BATCH_STALE_MS, BATCH_TITLE_PREFIX,
  normalizeBatchName, type BatchItemStatus, type BatchItemView, type BatchStatus, type BatchView,
} from './batch-spec';

type Fail = { ok: false; status: number; message: string };
const BATCH_COLUMNS = 'id, agent_id, name, status, total, stop_reason, created_at, finished_at';

type AgentRow = AgentAccessInfo & { name: string; app_definition: unknown; agent_type: string | null };

async function loadApp(agentId: string): Promise<AgentRow | null> {
  if (!/^[0-9a-f-]{36}$/i.test(agentId)) return null;
  const { data } = await supabaseAdmin.from('agents').select(`${AGENT_ACCESS_COLUMNS}, name, app_definition, agent_type`).eq('id', agentId).maybeSingle();
  return (data as AgentRow | null) ?? null;
}

/** 만들기 — 줄마다 앱 규칙으로 다시 검사(첫 오류 10개를 줄 번호와 함께), 실행 중 3개 상한 */
export async function createBatch(actor: ActorScope, body: unknown): Promise<{ ok: true; batch: BatchView } | Fail | { ok: false; status: 400; message: string; errors: string[] }> {
  if (!actor.organizationId) return { ok: false, status: 403, message: '소속 기관을 확인할 수 없습니다.' };
  const b = (body && typeof body === 'object' ? body : {}) as { agent_id?: unknown; name?: unknown; rows?: unknown };
  const agent = typeof b.agent_id === 'string' ? await loadApp(b.agent_id) : null;
  if (!agent || agent.agent_type === 'link' || !canUseAgent(agent, actor)) return { ok: false, status: 404, message: '앱을 찾을 수 없습니다.' };
  const definition = validateAppDefinition(agent.app_definition ?? null);
  if (!definition.ok || !definition.value) return { ok: false, status: 400, message: '입력형 앱만 일괄 실행할 수 있습니다.' };
  if (definition.value.attachments?.required) return { ok: false, status: 400, message: BATCH_FILES_UNSUPPORTED };
  if (!Array.isArray(b.rows) || !b.rows.length) return { ok: false, status: 400, message: '실행할 줄이 없습니다.' };
  if (b.rows.length > BATCH_MAX_ROWS) return { ok: false, status: 400, message: `한 번에 ${BATCH_MAX_ROWS}줄까지 실행합니다.` };
  const errors: string[] = [];
  const inputs: Record<string, string>[] = [];
  b.rows.forEach((row, i) => {
    const checked = renderAppInput(definition.value!, row);
    if (!checked.ok) errors.push(`${i + 1}번째 줄: ${checked.message}`);
    else inputs.push({ ...checked.inputs });
  });
  if (errors.length) return { ok: false, status: 400, message: errors[0], errors: errors.slice(0, 10) };
  const name = normalizeBatchName(b.name) ?? `${agent.name.slice(0, 60)} 일괄 실행`;
  const { count, error: countError } = await supabaseAdmin.from('app_batches').select('id', { count: 'exact', head: true }).eq('user_id', actor.userId).eq('status', 'running');
  if (countError) return { ok: false, status: 503, message: '일괄 실행을 만들지 못했습니다. 잠시 뒤 다시 시도해 주세요.' };
  if ((count ?? 0) >= BATCH_MAX_RUNNING) return { ok: false, status: 409, message: `실행 중인 일괄 실행은 ${BATCH_MAX_RUNNING}개까지입니다. 끝나거나 그만둔 뒤 다시 만들어 주세요.` };
  const { data: batch, error } = await supabaseAdmin.from('app_batches').insert({
    organization_id: actor.organizationId, department_id: actor.departmentId, user_id: actor.userId, agent_id: agent.id, app_version: agent.version, name, total: inputs.length,
  }).select(BATCH_COLUMNS).single();
  if (error || !batch) return { ok: false, status: 503, message: '일괄 실행을 만들지 못했습니다. 잠시 뒤 다시 시도해 주세요.' };
  const { error: itemError } = await supabaseAdmin.from('app_batch_items').insert(inputs.map((row, i) => ({ batch_id: batch.id, position: i + 1, inputs: row })));
  if (itemError) {
    await supabaseAdmin.from('app_batches').delete().eq('id', batch.id);
    return { ok: false, status: 503, message: '일괄 실행을 만들지 못했습니다. 잠시 뒤 다시 시도해 주세요.' };
  }
  return { ok: true, batch: batchView(batch as BatchRowView, agent.name, { done: 0, failed: 0, skipped: 0, pending: inputs.length }) };
}

type BatchRowView = { id: string; agent_id: string; name: string; status: BatchStatus; total: number; stop_reason: string | null; created_at: string; finished_at: string | null };
type Counts = { done: number; failed: number; skipped: number; pending: number };
const batchView = (r: BatchRowView, agentName: string | null, c: Counts): BatchView => ({
  id: r.id, agentId: r.agent_id, agentName, name: r.name, status: r.status, total: r.total, ...c, stopReason: r.stop_reason, createdAt: r.created_at, finishedAt: r.finished_at,
});

async function countsFor(batchIds: string[]): Promise<Map<string, Counts> | null> {
  const out = new Map<string, Counts>(batchIds.map((id) => [id, { done: 0, failed: 0, skipped: 0, pending: 0 }]));
  if (!batchIds.length) return out;
  const { data, error } = await supabaseAdmin.from('app_batch_items').select('batch_id, status').in('batch_id', batchIds).limit(BATCH_MAX_ROWS * batchIds.length);
  if (error) return null;
  for (const row of (data ?? []) as Array<{ batch_id: string; status: BatchItemStatus }>) {
    const c = out.get(row.batch_id);
    if (!c) continue;
    if (row.status === 'done') c.done++; else if (row.status === 'failed') c.failed++; else if (row.status === 'skipped') c.skipped++; else c.pending++;
  }
  return out;
}

/** 내 일괄 실행(최근 20개) — 앱을 주면 그 앱만 */
export async function listBatches(userId: string, agentId?: string | null): Promise<BatchView[] | null> {
  let q = supabaseAdmin.from('app_batches').select(`${BATCH_COLUMNS}, agent:agents(name)`).eq('user_id', userId).order('created_at', { ascending: false }).limit(20);
  if (agentId && /^[0-9a-f-]{36}$/i.test(agentId)) q = q.eq('agent_id', agentId);
  const { data, error } = await q;
  if (error) return null;
  const rows = (data ?? []) as Array<BatchRowView & { agent: { name: string } | { name: string }[] | null }>;
  const counts = await countsFor(rows.map((r) => r.id));
  if (!counts) return null;
  return rows.map((r) => batchView(r, (Array.isArray(r.agent) ? r.agent[0]?.name : r.agent?.name) ?? null, counts.get(r.id)!));
}

async function ownBatch(userId: string, id: string): Promise<(BatchRowView & { user_id: string }) | null> {
  if (!/^[0-9a-f-]{36}$/i.test(id)) return null;
  const { data } = await supabaseAdmin.from('app_batches').select(`${BATCH_COLUMNS}, user_id`).eq('id', id).eq('user_id', userId).maybeSingle();
  return (data as (BatchRowView & { user_id: string }) | null) ?? null;
}

/** 일괄 실행 하나와 줄들(입력·상태·오류·대화) — 만든 사람만 */
export async function getBatch(userId: string, id: string): Promise<{ batch: BatchView; items: BatchItemView[] } | null> {
  const batch = await ownBatch(userId, id);
  if (!batch) return null;
  const { data } = await supabaseAdmin.from('app_batch_items').select('position, status, error, conversation_id, inputs').eq('batch_id', id).order('position', { ascending: true }).limit(BATCH_MAX_ROWS);
  const items = ((data ?? []) as Array<{ position: number; status: BatchItemStatus; error: string | null; conversation_id: string | null; inputs: Record<string, string> }>)
    .map((r) => ({ position: r.position, status: r.status, error: r.error, conversationId: r.conversation_id, inputs: r.inputs ?? {} }));
  const counts: Counts = { done: 0, failed: 0, skipped: 0, pending: 0 };
  for (const it of items) { if (it.status === 'done') counts.done++; else if (it.status === 'failed') counts.failed++; else if (it.status === 'skipped') counts.skipped++; else counts.pending++; }
  const { data: agent } = await supabaseAdmin.from('agents').select('name').eq('id', batch.agent_id).maybeSingle();
  return { batch: batchView(batch, (agent as { name: string } | null)?.name ?? null, counts), items };
}

/** 그만두기 — 만든 사람만, 실행 중일 때만. 기다리던 줄은 건너뜀(이미 실행 중인 줄은 끝까지 간다) */
export async function cancelBatch(userId: string, id: string, nowMs = Date.now()): Promise<{ ok: true } | Fail> {
  const batch = await ownBatch(userId, id);
  if (!batch) return { ok: false, status: 404, message: '일괄 실행을 찾을 수 없습니다.' };
  const now = new Date(nowMs).toISOString();
  const { data, error } = await supabaseAdmin.from('app_batches').update({ status: 'cancelled', finished_at: now }).eq('id', id).eq('user_id', userId).eq('status', 'running').select('id');
  if (error) return { ok: false, status: 503, message: '그만두지 못했습니다. 잠시 뒤 다시 시도해 주세요.' };
  if (!data?.length) return { ok: false, status: 409, message: '이미 끝났거나 멈춘 일괄 실행입니다.' };
  await supabaseAdmin.from('app_batch_items').update({ status: 'skipped', finished_at: now, error: '직원이 그만뒀습니다.' }).eq('batch_id', id).eq('status', 'pending');
  return { ok: true };
}

// ── 실행기 ─────────────────────────────────────────────────────────

export interface BatchRunRow { id: string; organization_id: string; department_id: string; user_id: string; agent_id: string; app_version: number; status: BatchStatus }
export interface BatchItemRun { id: string; batch_id: string; position: number; inputs: Record<string, string>; status: 'pending' | 'running'; attempts: number; claimed_at: string | null; batch: BatchRunRow }
export type ItemPatch = { status: 'done' | 'failed' | 'skipped' | 'pending'; attempts: number; error: string | null; conversation_id?: string | null; message_id?: string | null };

export interface BatchDeps {
  now(): number;
  /** 실행 중인 묶음의 열린 줄(차례가 됐거나 멈춘 running) — 묶음을 만든 순서, 줄 순서 */
  openItems(staleIso: string, limit: number): Promise<BatchItemRun[] | null>;
  claim(item: BatchItemRun, nowIso: string, staleIso: string): Promise<boolean>;
  run(item: BatchItemRun, deadlineAt: number): Promise<RunAsOutcome>;
  finishItem(id: string, patch: ItemPatch, nowIso: string): Promise<void>;
  /** 묶음을 멈춤 — 남은 줄은 건너뜀 */
  stop(batchId: string, reason: string, nowIso: string): Promise<void>;
  /** 열린 줄이 없으면 묶음을 마침 */
  settle(batchId: string, nowIso: string): Promise<void>;
  log(message: string, details: Record<string, unknown>, orgId: string): Promise<void>;
}
export type BatchTick = { ran: number; done: number; failed: number; retried: number; stopped: number };

/** 시작 후 이 시간 안에서만 새 줄을 시작한다 — 실행 하나가 2분 남짓이라 함수 시간 제한(300초) 안에 끝나게 */
export const BATCH_START_WINDOW_MS = 90_000;
/** 줄 실행의 새 모델 호출 마감(시작 + 이만큼) */
export const BATCH_DEADLINE_MS = 150_000;
export const BATCH_CONCURRENCY = 2;

const stopReasonFor = (outcome: RunAsOutcome): string | null => {
  if (outcome.kind === 'user_unavailable') return '직원 계정을 쓸 수 없어 멈췄습니다.';
  if (outcome.kind === 'department_changed') return '소속 부서가 바뀌어 멈췄습니다 — 새로 만들어 주세요.';
  if (outcome.kind !== 'rejected') return null;
  if (outcome.status === 409) return '앱 설정이 바뀌어 멈췄습니다 — 지금 앱으로 새로 만들어 주세요.';
  if (outcome.status === 403 || outcome.status === 404) return '앱을 더 쓸 수 없어 멈췄습니다.';
  if (outcome.status === 429) return `사용 한도에 걸려 멈췄습니다 — ${outcome.message}`.slice(0, 300);
  return null;
};

/** 차례가 된 줄을 두 줄씩 나란히. 던지지 않는다 */
export async function runDueBatchItems(deps: BatchDeps): Promise<BatchTick> {
  const start = deps.now();
  const tick: BatchTick = { ran: 0, done: 0, failed: 0, retried: 0, stopped: 0 };
  const iso = (ms: number) => new Date(ms).toISOString();
  let queue: BatchItemRun[];
  try { queue = (await deps.openItems(iso(start - BATCH_STALE_MS), 20)) ?? []; } catch { queue = []; }
  const stoppedBatches = new Set<string>();
  const worker = async () => {
    while (queue.length) {
      if (deps.now() - start > BATCH_START_WINDOW_MS) return;
      const item = queue.shift()!;
      if (stoppedBatches.has(item.batch_id)) continue;
      const now = deps.now();
      if (!(await deps.claim(item, iso(now), iso(now - BATCH_STALE_MS)).catch(() => false))) continue;
      tick.ran++;
      const attempts = item.attempts + 1;
      let outcome: RunAsOutcome;
      try { outcome = await deps.run(item, start + BATCH_DEADLINE_MS); } catch (error) { outcome = { kind: 'failed', error: error instanceof Error ? error.message.slice(0, 300) : '알 수 없는 오류', conversationId: null }; }
      const doneAt = iso(deps.now());
      const stopReason = stopReasonFor(outcome);
      if (stopReason) {
        await deps.finishItem(item.id, { status: 'skipped', attempts, error: stopReason }, doneAt);
        await deps.stop(item.batch_id, stopReason, doneAt);
        stoppedBatches.add(item.batch_id);
        tick.stopped++;
        await deps.log('앱 일괄 실행을 멈췄습니다', { batch_id: item.batch_id, reason: stopReason, kind: outcome.kind }, item.batch.organization_id).catch(() => {});
        continue;
      }
      if (outcome.kind === 'completed') {
        await deps.finishItem(item.id, { status: 'done', attempts, error: null, conversation_id: outcome.conversationId, message_id: outcome.messageId ?? null }, doneAt);
        tick.done++;
      } else if (outcome.kind === 'failed' && attempts < BATCH_MAX_ATTEMPTS) {
        await deps.finishItem(item.id, { status: 'pending', attempts, error: outcome.error.slice(0, 300), conversation_id: outcome.conversationId }, doneAt);
        tick.retried++;
      } else {
        const error = outcome.kind === 'failed' ? outcome.error : outcome.kind === 'rejected' ? outcome.message : '실행하지 못했습니다.';
        await deps.finishItem(item.id, { status: 'failed', attempts, error: error.slice(0, 300), ...(outcome.kind === 'failed' ? { conversation_id: outcome.conversationId } : {}) }, doneAt);
        tick.failed++;
      }
      await deps.settle(item.batch_id, doneAt).catch(() => {});
    }
  };
  await Promise.all(Array.from({ length: BATCH_CONCURRENCY }, worker));
  return tick;
}

export function batchDeps(): BatchDeps {
  return {
    now: () => Date.now(),
    async openItems(staleIso, limit) {
      const { data: batches, error } = await supabaseAdmin.from('app_batches').select('id, organization_id, department_id, user_id, agent_id, app_version, status')
        .eq('status', 'running').order('created_at', { ascending: true }).limit(20);
      if (error) return null;
      const byId = new Map(((batches ?? []) as BatchRunRow[]).map((b) => [b.id, b]));
      if (!byId.size) return [];
      const { data: items, error: itemError } = await supabaseAdmin.from('app_batch_items').select('id, batch_id, position, inputs, status, attempts, claimed_at')
        .in('batch_id', [...byId.keys()])
        .or(`status.eq.pending,and(status.eq.running,claimed_at.lt.${staleIso})`)
        .order('position', { ascending: true }).limit(limit * 3);
      if (itemError) return null;
      const order = [...byId.keys()];
      return ((items ?? []) as Array<Omit<BatchItemRun, 'batch'>>)
        .map((it) => ({ ...it, batch: byId.get(it.batch_id)! }))
        .sort((a, b) => order.indexOf(a.batch_id) - order.indexOf(b.batch_id) || a.position - b.position)
        .slice(0, limit);
    },
    async claim(item, nowIso, staleIso) {
      let q = supabaseAdmin.from('app_batch_items').update({ status: 'running', claimed_at: nowIso }).eq('id', item.id);
      q = item.status === 'pending' ? q.eq('status', 'pending') : q.eq('status', 'running').lt('claimed_at', staleIso);
      const { data, error } = await q.select('id');
      return !error && Boolean(data?.length);
    },
    run: (item, deadlineAt) => runAppAs({
      userId: item.batch.user_id, departmentId: item.batch.department_id, agentId: item.batch.agent_id, appVersion: item.batch.app_version, inputs: item.inputs, deadlineAt,
    }, BATCH_TITLE_PREFIX, defaultRunAsIo()),
    async finishItem(id, patch, nowIso) {
      const terminal = patch.status !== 'pending';
      await supabaseAdmin.from('app_batch_items').update({ ...patch, claimed_at: null, finished_at: terminal ? nowIso : null }).eq('id', id).eq('status', 'running');
    },
    async stop(batchId, reason, nowIso) {
      await supabaseAdmin.from('app_batches').update({ status: 'stopped', stop_reason: reason, finished_at: nowIso }).eq('id', batchId).eq('status', 'running');
      await supabaseAdmin.from('app_batch_items').update({ status: 'skipped', finished_at: nowIso, error: reason }).eq('batch_id', batchId).eq('status', 'pending');
    },
    async settle(batchId, nowIso) {
      const { count, error } = await supabaseAdmin.from('app_batch_items').select('id', { count: 'exact', head: true }).eq('batch_id', batchId).in('status', ['pending', 'running']);
      if (error || (count ?? 0) > 0) return;
      await supabaseAdmin.from('app_batches').update({ status: 'done', finished_at: nowIso }).eq('id', batchId).eq('status', 'running');
    },
    async log(message, details, orgId) { await logSystem({ level: 'warning', category: 'api', message, details, orgId }); },
  };
}

// ── 결과 엑셀 ─────────────────────────────────────────────────────

/** 결과 엑셀 한 시트 — 번호·입력 항목들·상태·결과 글·오류·대화 주소(값만, 수식 주입 막음) */
export async function batchWorkbook(input: {
  name: string; fields: Array<{ key: string; label: string }>; origin: string;
  items: Array<BatchItemView & { result: string | null }>;
}): Promise<Buffer> {
  const ExcelJS = (await import('exceljs')).default;
  const workbook = new ExcelJS.Workbook();
  workbook.title = input.name;
  const sheet = workbook.addWorksheet('결과');
  sheet.addRow(['번호', ...input.fields.map((f) => safeText(f.label)), '상태', '결과', '오류', '대화']);
  sheet.getRow(1).font = { bold: true };
  sheet.views = [{ state: 'frozen', ySplit: 1 }];
  for (const it of input.items) {
    sheet.addRow([
      it.position, ...input.fields.map((f) => safeText(it.inputs[f.key] ?? '')), BATCH_ITEM_STATUS_LABELS[it.status],
      safeText(it.result ?? ''), safeText(it.error ?? ''), it.conversationId ? `${input.origin}/chat?conv=${it.conversationId}` : '',
    ]);
  }
  sheet.columns.forEach((col, i) => { col.width = i === 0 ? 6 : i === input.fields.length + 2 ? 80 : 20; });
  sheet.getColumn(input.fields.length + 3).alignment = { wrapText: true, vertical: 'top' };
  return Buffer.from(await workbook.xlsx.writeBuffer());
}

/** 엑셀에 넣을 줄마다 결과 글 — 그 실행의 답변 메시지(만든 사람의 대화만) */
export async function loadBatchResults(userId: string, batchId: string): Promise<Map<number, string> | null> {
  const { data, error } = await supabaseAdmin.from('app_batch_items').select('position, message_id').eq('batch_id', batchId).not('message_id', 'is', null).limit(BATCH_MAX_ROWS);
  if (error) return null;
  const rows = (data ?? []) as Array<{ position: number; message_id: string }>;
  if (!rows.length) return new Map();
  const { data: messages, error: messageError } = await supabaseAdmin.from('messages').select('id, content, conversation:conversations!inner(user_id)')
    .in('id', rows.map((r) => r.message_id)).eq('conversation.user_id', userId);
  if (messageError) return null;
  const text = new Map(((messages ?? []) as Array<{ id: string; content: string }>).map((m) => [m.id, m.content]));
  return new Map(rows.filter((r) => text.has(r.message_id)).map((r) => [r.position, text.get(r.message_id)!]));
}
