// src/lib/apps/batches.ts
// 입력형 앱 일괄 실행(0077) — 만들기·목록·그만두기·실행기·결과 엑셀(서버). 규칙은 batch-spec.ts.
//
// - 만들기: 직원이 쓸 수 있는 입력형 앱(파일이 꼭 필요한 앱은 빼고)에 줄마다 입력값을 앱 규칙(`renderAppInput`)으로 다시 검사해 저장한다.
//   한 사람에 실행 중 3개·한 번에 100줄. 앱 판·부서를 박아 두고, 실행 때 바뀌었으면 멈춘다(예약과 같은 판단).
// - 실행기: 앱 예약 실행기(pg_cron 5분)가 예약 실행과 나란히 부른다. 실행 중인 묶음의 줄을 만든 순서대로 조건부로 차지해
//   예약과 같은 `runAppAs`(그 직원의 세션 꼴 — 권한·한도·사용 기록이 손 실행과 같음)로 돌린다. 두 줄씩 나란히, 새 줄은 시작 90초 안에서만.
//   앱 변경·권한·계정·부서·한도 문제는 묶음을 멈추고(남은 줄은 건너뜀), 줄의 입력 문제는 그 줄만 실패, 모델 오류는 한 번 더 해 본다.
//   묶음을 마치거나 멈추면(그 조건부 갱신을 한 쪽만) 만든 직원에게 메일 한 통(줄 수·멈춘 이유·보내기 전 확인 수 — 입력·결과 글 없음, 2026-11-10).
//   직원이 그만둔 묶음은 알리지 않는다.
// - 파일마다 한 건(2026-11-10, 0079): 직원이 올린 읽힌 첨부(10개까지)를 줄마다 하나씩 사본(`app-batch-files/…`)으로 복사해 두고,
//   실행기가 그 줄을 돌릴 때 사본을 새 첨부로 다시 붙인다(예약의 올린 파일과 같은 길). 표는 한 줄(모든 파일에 같은 입력)이거나 파일 수와 같은 줄.
//   원본 첨부는 복사한 뒤 묘비로 지운다(보내지 않은 첨부 상한을 빨리 돌려줌). 사본은 묶음이 끝나면(마침·멈춤·그만둠) 지운다.
// - 결과: 줄마다 그 실행의 대화·답변 메시지를 가리킨다(결과 글을 따로 저장하지 않음). 엑셀은 입력·상태·결과 글·오류를 한 시트로(값만, 수식 주입 막음).
import { supabaseAdmin } from '@/lib/supabaseAdmin';
import type { ActorScope } from '@/lib/agent-permissions';
import { AGENT_ACCESS_COLUMNS, canUseAgent, type AgentAccessInfo } from '@/lib/agent-permissions';
import { renderAppInput, validateAppDefinition } from '@/lib/apps/definition';
import { defaultRunAsIo, runAppAs, type RunAsOutcome } from '@/lib/apps/run-as';
import { logSystem } from '@/lib/logger';
import { APP_URL } from '@/lib/config';
import { batchFinishedMail, isMailConfigured, sendBatchFinishedEmail } from '@/lib/mailer';
import { safeText } from '@/lib/xlsx-export';
import { OUTBOUND_STATUS_LABELS, type OutboundStatus } from './outbound/spec';
import {
  BATCH_FILES_NOT_ALLOWED, BATCH_FILES_UNSUPPORTED, BATCH_FILE_ROWS_MISMATCH, BATCH_ITEM_STATUS_LABELS, BATCH_MAX_ATTEMPTS, BATCH_MAX_FILES, BATCH_MAX_ROWS, BATCH_MAX_RUNNING,
  BATCH_APP_VERSION_CHANGED, BATCH_STALE_MS, BATCH_TITLE_PREFIX, batchFileOf, batchFilePath, normalizeBatchName, pairRowsWithFiles, parseBatchAttachmentIds,
  type BatchFile, type BatchItemStatus, type BatchItemView, type BatchStatus, type BatchView,
} from './batch-spec';
import { copyAttachmentsTo, defaultScheduleFileIo, discardAttachments, removeScheduleFileObjects, type ScheduleFileIo } from './schedule-files';
import { readBatchLimit } from './batch-limit';

type Fail = { ok: false; status: number; message: string };

const BATCH_COLUMNS = 'id, agent_id, name, status, total, stop_reason, created_at, finished_at';

type AgentRow = AgentAccessInfo & { name: string; app_definition: unknown; agent_type: string | null };

async function loadApp(agentId: string): Promise<AgentRow | null> {
  if (!/^[0-9a-f-]{36}$/i.test(agentId)) return null;
  const { data } = await supabaseAdmin.from('agents').select(`${AGENT_ACCESS_COLUMNS}, name, app_definition, agent_type`).eq('id', agentId).maybeSingle();
  return (data as AgentRow | null) ?? null;
}

/** 만들기 — 줄마다 앱 규칙으로 다시 검사(첫 오류 10개를 줄 번호와 함께), 실행 중 3개 상한 */
export async function createBatch(actor: ActorScope, body: unknown, opts: { source?: 'webhook'; appVersion?: number; webhookId?: string } = {}): Promise<{ ok: true; batch: BatchView } | Fail | { ok: false; status: 400; message: string; errors: string[] }> {
  if (!actor.organizationId) return { ok: false, status: 403, message: '소속 기관을 확인할 수 없습니다.' };
  const b = (body && typeof body === 'object' ? body : {}) as { agent_id?: unknown; name?: unknown; rows?: unknown; attachment_ids?: unknown };
  const agent = typeof b.agent_id === 'string' ? await loadApp(b.agent_id) : null;
  if (!agent || agent.agent_type === 'link' || !canUseAgent(agent, actor)) return { ok: false, status: 404, message: '앱을 찾을 수 없습니다.' };
  const definition = validateAppDefinition(agent.app_definition ?? null);
  if (!definition.ok || !definition.value) return { ok: false, status: 400, message: '입력형 앱만 일괄 실행할 수 있습니다.' };
  if (opts.appVersion !== undefined && agent.version !== opts.appVersion) return { ok: false, status: 409, message: BATCH_APP_VERSION_CHANGED };
  const attachmentIds = parseBatchAttachmentIds(b.attachment_ids);
  if (!attachmentIds) return { ok: false, status: 400, message: `파일은 ${BATCH_MAX_FILES}개까지 올려 주세요.` };
  const fileMode = attachmentIds.length > 0;
  if (fileMode && !definition.value.attachments) return { ok: false, status: 400, message: BATCH_FILES_NOT_ALLOWED };
  if (!fileMode && definition.value.attachments?.required) return { ok: false, status: 400, message: BATCH_FILES_UNSUPPORTED };
  if (!Array.isArray(b.rows) || !b.rows.length) return { ok: false, status: 400, message: '실행할 줄이 없습니다.' };
  if (b.rows.length > BATCH_MAX_ROWS) return { ok: false, status: 400, message: `한 번에 ${BATCH_MAX_ROWS}줄까지 실행합니다.` };
  if (fileMode && !pairRowsWithFiles(b.rows, attachmentIds.length)) return { ok: false, status: 400, message: BATCH_FILE_ROWS_MISMATCH };
  const errors: string[] = [];
  const checkedRows: Record<string, string>[] = [];
  b.rows.forEach((row, i) => {
    const checked = renderAppInput(definition.value!, row);
    if (!checked.ok) errors.push(`${i + 1}번째 줄: ${checked.message}`);
    else checkedRows.push({ ...checked.inputs });
  });
  if (errors.length) return { ok: false, status: 400, message: errors[0], errors: errors.slice(0, 10) };
  const inputs = fileMode ? pairRowsWithFiles(checkedRows, attachmentIds.length)!.map((row) => ({ ...row })) : checkedRows;
  // 기관이 정한 한 번 최대 줄 수(0084) — 읽지 못하면 만들지 않는다(관리자가 낮춘 상한을 넘지 않게)
  let orgLimit: number | null;
  try { orgLimit = await readBatchLimit(actor.organizationId); } catch { return { ok: false, status: 503, message: '일괄 실행 설정을 확인하지 못했습니다. 잠시 뒤 다시 시도해 주세요.' }; }
  if (orgLimit !== null && inputs.length > orgLimit) return { ok: false, status: 400, message: `기관이 정한 일괄 실행 상한은 한 번에 ${orgLimit}줄입니다(지금 ${inputs.length}줄). 나눠서 실행해 주세요.` };
  const name = normalizeBatchName(b.name) ?? `${agent.name.slice(0, 60)} 일괄 실행`;
  const { count, error: countError } = await supabaseAdmin.from('app_batches').select('id', { count: 'exact', head: true }).eq('user_id', actor.userId).eq('status', 'running');
  if (countError) return { ok: false, status: 503, message: '일괄 실행을 만들지 못했습니다. 잠시 뒤 다시 시도해 주세요.' };
  if ((count ?? 0) >= BATCH_MAX_RUNNING) return { ok: false, status: 409, message: `실행 중인 일괄 실행은 ${BATCH_MAX_RUNNING}개까지입니다. 끝나거나 그만둔 뒤 다시 만들어 주세요.` };
  // 파일마다 한 건 — 직원의 읽힌 첨부(요청자의 것·ready만)를 줄마다 사본으로
  let files: BatchFile[] = [];
  if (fileMode) {
    const organizationId = actor.organizationId;
    const copied = await copyAttachmentsTo({ userId: actor.userId, organizationId }, attachmentIds, (fileId, ext) => batchFilePath(organizationId, actor.userId, fileId, ext));
    if (!copied.ok) return { ok: false, status: copied.status, message: copied.status === 400 ? '일괄 실행에 붙일 파일을 찾을 수 없습니다. 파일을 다시 올려 주세요.' : '파일을 저장하지 못했습니다. 잠시 뒤 다시 시도해 주세요.' };
    files = copied.files;
  }
  const failCreate = async () => {
    await removeScheduleFileObjects(files, '일괄 실행 만들기 실패 뒤 정리');
    return { ok: false as const, status: 503, message: '일괄 실행을 만들지 못했습니다. 잠시 뒤 다시 시도해 주세요.' };
  };
  const { data: batch, error } = await supabaseAdmin.from('app_batches').insert({
    organization_id: actor.organizationId, department_id: actor.departmentId, user_id: actor.userId, agent_id: agent.id, app_version: agent.version, name, total: inputs.length,
    // 비동기 연동이 만든 묶음(0087) — 마침 메일을 보내지 않는다(호출마다 메일이 가지 않게)
    ...(opts.source ? { source: opts.source } : {}),
    ...(opts.source === 'webhook' && opts.webhookId ? { webhook_id: opts.webhookId } : {}),
  }).select(BATCH_COLUMNS).single();
  if (error || !batch) return failCreate();
  const { error: itemError } = await supabaseAdmin.from('app_batch_items').insert(inputs.map((row, i) => ({ batch_id: batch.id, position: i + 1, inputs: row, ...(files[i] ? { file: files[i] } : {}) })));
  if (itemError) {
    await supabaseAdmin.from('app_batches').delete().eq('id', batch.id);
    return failCreate();
  }
  // 원본 첨부는 사본을 만들었으니 묘비로(보내지 않은 첨부 상한을 빨리 돌려준다 — 실행 때 다시 붙일 몫)
  if (fileMode) await discardAttachments(actor.userId, attachmentIds);
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
  const { data } = await supabaseAdmin.from('app_batch_items').select('position, status, error, conversation_id, inputs, file').eq('batch_id', id).order('position', { ascending: true }).limit(BATCH_MAX_ROWS);
  const items = ((data ?? []) as Array<{ position: number; status: BatchItemStatus; error: string | null; conversation_id: string | null; inputs: Record<string, string>; file?: unknown }>)
    .map((r) => ({ position: r.position, status: r.status, error: r.error, conversationId: r.conversation_id, inputs: r.inputs ?? {}, fileName: batchFileOf(r.file)?.name ?? null }));
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
  await removeBatchFiles(id).catch(() => undefined);
  return { ok: true };
}

/**
 * 마치지 못한 줄만 다시 실행(2026-11-10, 마이그레이션 없음) — 끝난 내 묶음(마침·멈춤·그만둠)의 실패·건너뛴 줄의 입력으로 **새 일괄 실행**을 만든다.
 * 만들기와 같은 길(`createBatch`)이라 지금 앱 판·앱 규칙·실행 중 3개·기관 상한을 그대로 본다. 파일마다 한 건의 줄은 사본을 이미 지워 다시 실행할 수 없어 빼고 수를 알린다
 */
export async function retryUnfinished(actor: ActorScope, batchId: string): Promise<{ ok: true; batch: BatchView; skippedFiles: number } | Fail | { ok: false; status: 400; message: string; errors: string[] }> {
  const batch = await ownBatch(actor.userId, batchId);
  if (!batch) return { ok: false, status: 404, message: '일괄 실행을 찾을 수 없습니다.' };
  if (batch.status === 'running') return { ok: false, status: 409, message: '아직 실행 중인 일괄 실행입니다. 끝난 뒤에 다시 실행할 수 있습니다.' };
  const { data, error } = await supabaseAdmin.from('app_batch_items').select('position, inputs, file, status').eq('batch_id', batchId).in('status', ['failed', 'skipped']).order('position', { ascending: true }).limit(BATCH_MAX_ROWS);
  if (error) return { ok: false, status: 503, message: '줄을 불러오지 못했습니다. 잠시 뒤 다시 시도해 주세요.' };
  const rows = (data ?? []) as Array<{ position: number; inputs: Record<string, string>; file?: unknown }>;
  const tableRows = rows.filter((r) => r.file === null || r.file === undefined);
  const skippedFiles = rows.length - tableRows.length;
  if (!tableRows.length) return { ok: false, status: 409, message: skippedFiles ? '파일마다 한 건의 줄은 파일을 다시 올려 새로 실행해 주세요(사본은 일괄 실행이 끝날 때 지웠습니다).' : '다시 실행할 줄(실패·건너뜀)이 없습니다.' };
  const created = await createBatch(actor, { agent_id: batch.agent_id, name: `${batch.name.slice(0, 74)} 다시`, rows: tableRows.map((r) => r.inputs ?? {}) });
  if (!created.ok) return created;
  return { ok: true, batch: created.batch, skippedFiles };
}

/** 끝난 묶음의 파일 사본 지우기(파일마다 한 건) — 줄의 파일 이름은 남긴다(결과 엑셀). 실패는 기록만, 던지지 않는다 */
export async function removeBatchFiles(batchId: string): Promise<void> {
  const { data, error } = await supabaseAdmin.from('app_batch_items').select('file').eq('batch_id', batchId).not('file', 'is', null).limit(BATCH_MAX_ROWS);
  if (error) {
    await logSystem({ level: 'warning', category: 'database', message: '일괄 실행 파일 사본을 찾지 못했습니다 — 사본이 남았을 수 있음', details: { batch_id: batchId, error: error.message } }).catch(() => undefined);
    return;
  }
  const files = ((data ?? []) as Array<{ file: unknown }>).map((r) => batchFileOf(r.file)).filter((f): f is BatchFile => Boolean(f));
  await removeScheduleFileObjects(files, '일괄 실행이 끝난 뒤');
}

// ── 실행기 ─────────────────────────────────────────────────────────

export interface BatchRunRow { id: string; organization_id: string; department_id: string; user_id: string; agent_id: string; app_version: number; status: BatchStatus }
export interface BatchItemRun { id: string; batch_id: string; position: number; inputs: Record<string, string>; status: 'pending' | 'running'; attempts: number; claimed_at: string | null; batch: BatchRunRow; file?: unknown }
export type ItemPatch = { status: 'done' | 'failed' | 'skipped' | 'pending'; attempts: number; error: string | null; conversation_id?: string | null; message_id?: string | null };

export interface BatchDeps {
  now(): number;
  /** 실행 중인 묶음의 열린 줄(차례가 됐거나 멈춘 running) — 묶음을 만든 순서, 줄 순서 */
  openItems(staleIso: string, limit: number): Promise<BatchItemRun[] | null>;
  claim(item: BatchItemRun, nowIso: string, staleIso: string): Promise<boolean>;
  run(item: BatchItemRun, deadlineAt: number): Promise<RunAsOutcome>;
  finishItem(id: string, patch: ItemPatch, nowIso: string): Promise<void>;
  /** 묶음을 멈춤 — 남은 줄은 건너뜀. 이 호출이 묶음을 멈췄으면 true */
  stop(batchId: string, reason: string, nowIso: string): Promise<boolean | void>;
  /** 열린 줄이 없으면 묶음을 마침. 이 호출이 묶음을 마쳤으면 true */
  settle(batchId: string, nowIso: string): Promise<boolean | void>;
  /** 마치거나 멈춘 묶음을 만든 직원에게 알림(메일) — 보냈으면 true. 던져도 실행기는 이어 간다 */
  notifyFinished?(batchId: string): Promise<boolean>;
  /** 끝난 묶음(이 호출이 마치거나 멈춤)의 파일 사본 지우기. 던져도 실행기는 이어 간다 */
  cleanup?(batchId: string): Promise<void>;
  log(message: string, details: Record<string, unknown>, orgId: string): Promise<void>;
}
export type BatchTick = { ran: number; done: number; failed: number; retried: number; stopped: number; notified: number };

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
  const tick: BatchTick = { ran: 0, done: 0, failed: 0, retried: 0, stopped: 0, notified: 0 };
  const iso = (ms: number) => new Date(ms).toISOString();
  let queue: BatchItemRun[];
  try { queue = (await deps.openItems(iso(start - BATCH_STALE_MS), 20)) ?? []; } catch { queue = []; }
  const stoppedBatches = new Set<string>();
  const notify = async (batch: BatchRunRow) => {
    if (deps.cleanup) await deps.cleanup(batch.id).catch(() => undefined);
    if (!deps.notifyFinished) return;
    try { if (await deps.notifyFinished(batch.id)) tick.notified++; } catch (error) {
      await deps.log('앱 일괄 실행 마침 메일을 보내지 못했습니다', { batch_id: batch.id, error: error instanceof Error ? error.message.slice(0, 200) : 'unknown' }, batch.organization_id).catch(() => {});
    }
  };
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
        const ended = await deps.stop(item.batch_id, stopReason, doneAt).catch(() => false);
        stoppedBatches.add(item.batch_id);
        tick.stopped++;
        await deps.log('앱 일괄 실행을 멈췄습니다', { batch_id: item.batch_id, reason: stopReason, kind: outcome.kind }, item.batch.organization_id).catch(() => {});
        if (ended === true) await notify(item.batch);
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
      if ((await deps.settle(item.batch_id, doneAt).catch(() => false)) === true) await notify(item.batch);
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
      const { data: items, error: itemError } = await supabaseAdmin.from('app_batch_items').select('id, batch_id, position, inputs, status, attempts, claimed_at, file')
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
    run: (item, deadlineAt) => runBatchItem(item, deadlineAt),
    async finishItem(id, patch, nowIso) {
      const terminal = patch.status !== 'pending';
      await supabaseAdmin.from('app_batch_items').update({ ...patch, claimed_at: null, finished_at: terminal ? nowIso : null }).eq('id', id).eq('status', 'running');
    },
    async stop(batchId, reason, nowIso) {
      const { data } = await supabaseAdmin.from('app_batches').update({ status: 'stopped', stop_reason: reason, finished_at: nowIso }).eq('id', batchId).eq('status', 'running').select('id');
      await supabaseAdmin.from('app_batch_items').update({ status: 'skipped', finished_at: nowIso, error: reason }).eq('batch_id', batchId).eq('status', 'pending');
      return Boolean(data?.length);
    },
    async settle(batchId, nowIso) {
      const { count, error } = await supabaseAdmin.from('app_batch_items').select('id', { count: 'exact', head: true }).eq('batch_id', batchId).in('status', ['pending', 'running']);
      if (error || (count ?? 0) > 0) return false;
      const { data } = await supabaseAdmin.from('app_batches').update({ status: 'done', finished_at: nowIso }).eq('id', batchId).eq('status', 'running').select('id');
      return Boolean(data?.length);
    },
    notifyFinished: (batchId) => notifyBatchFinished(batchId),
    cleanup: (batchId) => removeBatchFiles(batchId),
    async log(message, details, orgId) { await logSystem({ level: 'warning', category: 'api', message, details, orgId }); },
  };
}

export interface BatchRunIo {
  files: ScheduleFileIo;
  runAs(input: Parameters<typeof runAppAs>[0]): Promise<RunAsOutcome>;
}
const defaultBatchRunIo = (): BatchRunIo => ({ files: defaultScheduleFileIo, runAs: (input) => runAppAs(input, BATCH_TITLE_PREFIX, defaultRunAsIo()) });

/**
 * 줄 하나 실행 — 파일마다 한 건이면 그 줄의 사본을 새 첨부로 다시 붙여 함께 실행한다.
 * 사본을 못 불러오면 '실패'(한 번 더 해 봄), 사본이 없거나 붙인 파일을 읽지 못하면 그 줄만 실패(400 — 다시 해도 같음). 시작 전에 끝났으면 붙인 첨부를 묘비로
 */
export async function runBatchItem(item: BatchItemRun, deadlineAt: number, io: BatchRunIo = defaultBatchRunIo()): Promise<RunAsOutcome> {
  const actor = { userId: item.batch.user_id, departmentId: item.batch.department_id, organizationId: item.batch.organization_id };
  const base = { userId: actor.userId, departmentId: actor.departmentId, agentId: item.batch.agent_id, appVersion: item.batch.app_version, inputs: item.inputs, deadlineAt };
  if (item.file === undefined || item.file === null) return io.runAs(base);
  const file = batchFileOf(item.file);
  if (!file) return { kind: 'rejected', status: 400, message: '이 줄의 파일 정보를 읽지 못했습니다.' };
  let attached: Awaited<ReturnType<ScheduleFileIo['attach']>>;
  try { attached = await io.files.attach(actor, file); } catch { return { kind: 'failed', error: `파일 '${file.name}'을 붙이지 못했습니다(잠시 뒤 다시).`, conversationId: null }; }
  if (!attached.ok) {
    if (attached.status === 404) return { kind: 'rejected', status: 400, message: `파일 '${file.name}'의 사본이 남아 있지 않습니다.` };
    return { kind: 'failed', error: `파일 '${file.name}'을 붙이지 못했습니다: ${attached.message}`.slice(0, 300), conversationId: null };
  }
  const attachmentId = attached.attachment.id;
  if (attached.attachment.status !== 'ready') {
    await discardAttachments(actor.userId, [attachmentId], io.files);
    return { kind: 'rejected', status: 400, message: `파일 '${file.name}'을 읽지 못했습니다${attached.attachment.error ? `(${attached.attachment.error})` : ''}.`.slice(0, 300) };
  }
  const outcome = await io.runAs({ ...base, attachmentIds: [attachmentId] });
  if (outcome.kind !== 'completed' && outcome.kind !== 'failed') await discardAttachments(actor.userId, [attachmentId], io.files);
  return outcome;
}

/** 마치거나 멈춘 묶음의 안내 메일 — 메일이 설정돼 있고 주소가 있을 때만. 보내지 못하면 던진다(실행기가 기록) */
export async function notifyBatchFinished(batchId: string, io: BatchNoticeIo = batchNoticeIo()): Promise<boolean> {
  if (!io.mailConfigured()) return false;
  const facts = await io.load(batchId);
  if (!facts || (facts.status !== 'done' && facts.status !== 'stopped')) return false;
  // 비동기 연동(0087)이 만든 한 줄 묶음은 메일을 보내지 않는다 — 결과는 연동의 결과 보낼 곳·앱 실행 기록으로 본다
  if (facts.source === 'webhook') return false;
  const to = facts.email?.trim() ?? '';
  if (!to) return false;
  const runUrl = `${APP_URL}/apps/run?agent=${encodeURIComponent(facts.agentId)}`;
  const mail = batchFinishedMail({
    appName: facts.appName, batchName: facts.name, stopped: facts.status === 'stopped', stopReason: facts.stopReason,
    total: facts.total, done: facts.done, failed: facts.failed, skipped: facts.skipped, awaitingApproval: facts.awaitingApproval,
    finishedAt: facts.finishedAt ? new Date(facts.finishedAt) : new Date(), runUrl,
    ...(facts.done + facts.failed > 0 ? { exportUrl: `${APP_URL}/api/apps/batches/${encodeURIComponent(batchId)}/export` } : {}),
  });
  const sent = await io.send(to, mail);
  if (!sent.sent) throw new Error(sent.error ?? sent.reason ?? 'send_failed');
  return true;
}

export interface BatchNoticeFacts {
  agentId: string; appName: string; name: string; status: BatchStatus; stopReason: string | null; total: number; finishedAt: string | null;
  done: number; failed: number; skipped: number; awaitingApproval: number; email: string | null;
  /** 만든 곳(0087) — 'webhook'이면 메일 없음 */
  source?: string | null;
}
export interface BatchNoticeIo {
  mailConfigured(): boolean;
  load(batchId: string): Promise<BatchNoticeFacts | null>;
  send(to: string, mail: { subject: string; html: string }): Promise<{ sent: boolean; reason?: string; error?: string }>;
}

function batchNoticeIo(): BatchNoticeIo {
  return {
    mailConfigured: isMailConfigured,
    async load(batchId) {
      const { data: batch, error } = await supabaseAdmin.from('app_batches').select('id, user_id, agent_id, name, status, total, stop_reason, finished_at, source').eq('id', batchId).maybeSingle();
      if (error) throw new Error(error.message);
      if (!batch) return null;
      const b = batch as { user_id: string; agent_id: string; name: string; status: BatchStatus; total: number; stop_reason: string | null; finished_at: string | null; source?: string | null };
      const [{ data: items, error: itemError }, { data: user }, { data: agent }] = await Promise.all([
        supabaseAdmin.from('app_batch_items').select('status, message_id').eq('batch_id', batchId),
        supabaseAdmin.from('users').select('email').eq('id', b.user_id).maybeSingle(),
        supabaseAdmin.from('agents').select('name').eq('id', b.agent_id).maybeSingle(),
      ]);
      if (itemError) throw new Error(itemError.message);
      const rows = (items ?? []) as Array<{ status: string; message_id: string | null }>;
      const messageIds = rows.map((r) => r.message_id).filter((v): v is string => typeof v === 'string');
      let awaitingApproval = 0;
      if (messageIds.length) {
        // 이 묶음의 답변 중 보내기 전 확인(0078)을 기다리는 것 — 그 직원의 기록만
        const { count } = await supabaseAdmin.from('app_outbound_deliveries').select('id', { count: 'exact', head: true })
          .eq('user_id', b.user_id).eq('status', 'awaiting_approval').in('message_id', messageIds);
        awaitingApproval = count ?? 0;
      }
      return {
        agentId: b.agent_id, appName: (agent as { name?: string } | null)?.name ?? '입력형 앱', name: b.name, status: b.status, stopReason: b.stop_reason, total: b.total, finishedAt: b.finished_at,
        done: rows.filter((r) => r.status === 'done').length, failed: rows.filter((r) => r.status === 'failed').length, skipped: rows.filter((r) => r.status === 'skipped').length,
        awaitingApproval, email: typeof (user as { email?: unknown } | null)?.email === 'string' ? (user as { email: string }).email : null,
        source: b.source ?? null,
      };
    },
    send: sendBatchFinishedEmail,
  };
}

// ── 결과 엑셀 ─────────────────────────────────────────────────────

/** 줄의 외부 보내기(0076) 상태·받는 쪽 접수 번호(0080) — 결과 엑셀 '보내기'·'접수 번호' 열 */
export type BatchDeliveryCell = { status: OutboundStatus; receiptRef: string | null };

/** 결과 엑셀 한 시트 — 번호·(파일마다 한 건이면 파일)·입력 항목들·상태·결과 글·오류·대화 주소·(보낸 줄이 있으면 보내기·접수 번호)(값만, 수식 주입 막음) */
export async function batchWorkbook(input: {
  name: string; fields: Array<{ key: string; label: string }>; origin: string;
  items: Array<BatchItemView & { result: string | null; delivery?: BatchDeliveryCell | null }>;
}): Promise<Buffer> {
  const ExcelJS = (await import('exceljs')).default;
  const workbook = new ExcelJS.Workbook();
  workbook.title = input.name;
  const sheet = workbook.addWorksheet('결과');
  const withFile = input.items.some((it) => it.fileName);
  const withDelivery = input.items.some((it) => it.delivery);
  sheet.addRow(['번호', ...(withFile ? ['파일'] : []), ...input.fields.map((f) => safeText(f.label)), '상태', '결과', '오류', '대화', ...(withDelivery ? ['보내기', '접수 번호'] : [])]);
  sheet.getRow(1).font = { bold: true };
  sheet.views = [{ state: 'frozen', ySplit: 1 }];
  for (const it of input.items) {
    sheet.addRow([
      it.position, ...(withFile ? [safeText(it.fileName ?? '')] : []), ...input.fields.map((f) => safeText(it.inputs[f.key] ?? '')), BATCH_ITEM_STATUS_LABELS[it.status],
      safeText(it.result ?? ''), safeText(it.error ?? ''), it.conversationId ? `${input.origin}/chat?conv=${it.conversationId}` : '',
      ...(withDelivery ? [it.delivery ? OUTBOUND_STATUS_LABELS[it.delivery.status] ?? it.delivery.status : '', safeText(it.delivery?.receiptRef ?? '')] : []),
    ]);
  }
  const lead = withFile ? 1 : 0;
  sheet.columns.forEach((col, i) => { col.width = i === 0 ? 6 : i === input.fields.length + lead + 2 ? 80 : 20; });
  sheet.getColumn(input.fields.length + lead + 3).alignment = { wrapText: true, vertical: 'top' };
  return Buffer.from(await workbook.xlsx.writeBuffer());
}

/** 엑셀에 넣을 줄마다 보내기 상태·접수 번호 — 만든 사람의 보내기 기록만(그 실행의 답변 메시지로 맞춤). 못 읽으면 null(열 없이) */
export async function loadBatchDeliveries(userId: string, batchId: string): Promise<Map<number, BatchDeliveryCell> | null> {
  const { data, error } = await supabaseAdmin.from('app_batch_items').select('position, message_id').eq('batch_id', batchId).not('message_id', 'is', null).limit(BATCH_MAX_ROWS);
  if (error) return null;
  const rows = (data ?? []) as Array<{ position: number; message_id: string }>;
  if (!rows.length) return new Map();
  const { data: deliveries, error: dErr } = await supabaseAdmin.from('app_outbound_deliveries').select('message_id, status, receipt_ref, created_at')
    .eq('user_id', userId).in('message_id', rows.map((r) => r.message_id)).order('created_at', { ascending: true });
  if (dErr) return null;
  // 같은 답변을 두 곳으로 보냈으면 나중 기록
  const byMessage = new Map(((deliveries ?? []) as Array<{ message_id: string; status: OutboundStatus; receipt_ref: string | null }>).map((d) => [d.message_id, { status: d.status, receiptRef: d.receipt_ref ?? null }]));
  return new Map(rows.filter((r) => byMessage.has(r.message_id)).map((r) => [r.position, byMessage.get(r.message_id)!]));
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
