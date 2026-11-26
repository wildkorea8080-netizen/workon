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
// - 문서함에서 고른 문서(2026-11-26, 0131): 묶음에 id로 두고 줄마다 지금 근거 판으로 읽어 함께 실행한다(예약 0062와 같은 `currentEditionIds`, 쓸 판이 없으면 묶음 멈춤).
// - 파일마다 한 건(2026-11-10, 0079): 직원이 올린 읽힌 첨부(10개까지)를 줄마다 하나씩 사본(`app-batch-files/…`)으로 복사해 두고,
//   실행기가 그 줄을 돌릴 때 사본을 새 첨부로 다시 붙인다(예약의 올린 파일과 같은 길). 표는 한 줄(모든 파일에 같은 입력)이거나 파일 수와 같은 줄.
//   원본 첨부는 복사한 뒤 묘비로 지운다(보내지 않은 첨부 상한을 빨리 돌려줌). 사본은 묶음이 끝나면(마침·멈춤·그만둠) 지운다.
// - 기대 핵심어(2026-11-11, 0088): 줄마다 '기대 핵심어'를 두면 실행기가 줄을 마칠 때 그 실행의 답변 글에 핵심어가 모두 있는지 한 번 재
//   `expect_missing`에 둔다(모델 호출 없음 — 문서 찾기 평가의 핵심어와 같은 규칙). 목록은 맞은 줄 수, 엑셀은 줄마다 맞음·빠진 핵심어.
// - AI 채점(2026-11-26, 0125): 만들 때 고르면(기대 답 칸이 있을 때만) 줄을 마칠 때 그 앱의 모델로 결과가 기대 답과 맞는지 맞음·일부·틀림과 이유를
//   `judge_grade`·`judge_reason`에 둔다(batch-judge.ts — 참고, 핵심어 판정은 그대로, 사용 기록 `app_batch_judge`). 목록은 등급별 줄 수, 엑셀은 'AI 채점' 열.
// - 사람 판정(0126): 만든 직원이 마친 줄마다 맞음·일부·틀림을 매기면(`labelBatchItem`) AI 채점과 맞대 일치율·후하게/짜게 본 줄·3×3 표를 센다
//   (`batchAgreement` — 문서 찾기 평가의 `judgeAgreement`와 같은 셈, 모델 호출 없음). 목록·상세에 맞대기, 엑셀은 '사람 판정' 열.
// - 비동기 연동이 넣은 묶음(0087)은 줄이 끝나면 그 연동의 '마지막 결과'를 바꾼다(기다리는 호출과 같은 칸 — 2026-11-11).
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
  BATCH_FILES_NOT_ALLOWED, BATCH_FILES_UNSUPPORTED, BATCH_FILE_ROWS_MISMATCH, BATCH_ITEM_STATUS_LABELS, BATCH_MAX_ATTEMPTS, BATCH_MAX_FILES, BATCH_MAX_ROWS, BATCH_MAX_RUNNING, BATCH_ROWS_CEILING,
  BATCH_APP_VERSION_CHANGED, BATCH_DOCUMENTS_GONE_STATUS, BATCH_DOCUMENTS_UNAVAILABLE, BATCH_EXPECT_MAX, BATCH_FILES_OR_DOCUMENTS, BATCH_STALE_MS, BATCH_TITLE_PREFIX, batchFileOf, batchFilePath, expectMissing, expectVerdict, normalizeBatchName, normalizeExpect,
  pairRowsWithFiles, parseBatchAttachmentIds, BATCH_JUDGE_NEEDS_EXPECT, isBatchJudgeGrade, judgeVerdict, BATCH_JUDGE_LABELS, BATCH_HUMAN_ONLY_DONE, batchAgreement,
  type BatchFile, type BatchJudgeGrade, type BatchItemStatus, type BatchItemView, type BatchStatus, type BatchView,
} from './batch-spec';
import { copyAttachmentsTo, defaultScheduleFileIo, discardAttachments, removeScheduleFileObjects, type ScheduleFileIo } from './schedule-files';
import { readBatchLimit } from './batch-limit';
import { CHOSEN_DOCUMENTS_UNAVAILABLE, agentDocumentRows, appDocumentChoice, verifyChosenDocuments } from './app-document-choice';
import { currentEditionIds, type LibraryDocumentRow } from './library-documents';
import { pagedRows } from '@/lib/paged-select';
import { BATCH_JUDGE_NO_TIME, judgeBatchResult, type BatchJudgeResult } from './batch-judge';

/** `.in(칸, ids)`를 이만큼씩 나눠 부른다 — 500줄(0123)의 답변 id를 한 주소에 다 실으면 요청 주소가 너무 길어진다 */
export const BATCH_IN_CHUNK = 100;
export function idChunks<T>(ids: T[], size = BATCH_IN_CHUNK): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < ids.length; i += size) out.push(ids.slice(i, i + size));
  return out;
}

type Fail = { ok: false; status: number; message: string };

const BATCH_COLUMNS = 'id, agent_id, name, status, total, stop_reason, created_at, finished_at, judge, document_ids';

type AgentRow = AgentAccessInfo & { name: string; app_definition: unknown; agent_type: string | null };

/** 없으면 null, 못 읽으면 'unread'(2026-11-20 — 예전엔 읽기 실패도 '앱을 찾을 수 없습니다'(404)라 외부 연동이 다시 시도하지 않았다) */
async function loadApp(agentId: string): Promise<AgentRow | null | 'unread'> {
  if (!/^[0-9a-f-]{36}$/i.test(agentId)) return null;
  const { data, error } = await supabaseAdmin.from('agents').select(`${AGENT_ACCESS_COLUMNS}, name, app_definition, agent_type`).eq('id', agentId).maybeSingle();
  if (error) return 'unread';
  return (data as AgentRow | null) ?? null;
}

/** 만들기 — 줄마다 앱 규칙으로 다시 검사(첫 오류 10개를 줄 번호와 함께), 실행 중 3개 상한 */
export async function createBatch(actor: ActorScope, body: unknown, opts: { source?: 'webhook'; appVersion?: number; webhookId?: string } = {}): Promise<{ ok: true; batch: BatchView } | Fail | { ok: false; status: 400; message: string; errors: string[] }> {
  if (!actor.organizationId) return { ok: false, status: 403, message: '소속 기관을 확인할 수 없습니다.' };
  const b = (body && typeof body === 'object' ? body : {}) as { agent_id?: unknown; name?: unknown; rows?: unknown; attachment_ids?: unknown; expects?: unknown; judge?: unknown; document_ids?: unknown };
  const agent = typeof b.agent_id === 'string' ? await loadApp(b.agent_id) : null;
  if (agent === 'unread') return { ok: false, status: 503, message: '앱을 지금 읽지 못했습니다. 잠시 뒤 다시 시도해 주세요.' };
  if (!agent || agent.agent_type === 'link' || !canUseAgent(agent, actor)) return { ok: false, status: 404, message: '앱을 찾을 수 없습니다.' };
  const definition = validateAppDefinition(agent.app_definition ?? null);
  if (!definition.ok || !definition.value) return { ok: false, status: 400, message: '입력형 앱만 일괄 실행할 수 있습니다.' };
  if (opts.appVersion !== undefined && agent.version !== opts.appVersion) return { ok: false, status: 409, message: BATCH_APP_VERSION_CHANGED };
  const attachmentIds = parseBatchAttachmentIds(b.attachment_ids);
  if (!attachmentIds) return { ok: false, status: 400, message: `파일은 ${BATCH_MAX_FILES}개까지 올려 주세요.` };
  const fileMode = attachmentIds.length > 0;
  if (fileMode && !definition.value.attachments) return { ok: false, status: 400, message: BATCH_FILES_NOT_ALLOWED };
  // 문서함에서 고른 문서(0131) — 모든 줄이 함께 쓴다. 파일마다 한 건이면 줄마다 파일 하나를 더해 3개까지. 비동기 연동 묶음은 고르지 않는다
  const docChoice = appDocumentChoice(definition.value.attachments, b.document_ids, '일괄 실행', fileMode ? 1 : 0);
  if (!docChoice.ok) return { ok: false, status: 400, message: docChoice.message };
  const documentIds = docChoice.ids;
  if (documentIds.length && opts.source === 'webhook') return { ok: false, status: 400, message: '비동기 연동 실행에는 문서함 문서를 고를 수 없습니다.' };
  if (!fileMode && definition.value.attachments?.required && !documentIds.length) return { ok: false, status: 400, message: definition.value.attachments.library ? BATCH_FILES_OR_DOCUMENTS : BATCH_FILES_UNSUPPORTED };
  if (!Array.isArray(b.rows) || !b.rows.length) return { ok: false, status: 400, message: '실행할 줄이 없습니다.' };
  if (b.rows.length > BATCH_ROWS_CEILING) return { ok: false, status: 400, message: `한 번에 ${BATCH_ROWS_CEILING}줄까지 실행합니다.` };
  if (fileMode && !pairRowsWithFiles(b.rows, attachmentIds.length)) return { ok: false, status: 400, message: BATCH_FILE_ROWS_MISMATCH };
  // 기대 핵심어(0088) — 주면 줄과 같은 수, 줄마다 글(비면 그 줄은 재지 않음)
  let expects: (string | null)[] = b.rows.map(() => null);
  if (b.expects !== undefined && b.expects !== null) {
    if (!Array.isArray(b.expects) || b.expects.length !== b.rows.length) return { ok: false, status: 400, message: '기대 핵심어는 줄마다 하나씩(줄 수와 같게) 보내 주세요.' };
    const normalized = b.expects.map(normalizeExpect);
    const tooLong = normalized.findIndex((e) => e === 'too_long');
    if (tooLong >= 0) return { ok: false, status: 400, message: `${tooLong + 1}번째 줄: 기대 핵심어는 ${BATCH_EXPECT_MAX}자까지입니다.` };
    expects = normalized as (string | null)[];
  }
  // AI 채점(0125) — 참·거짓만, 기대 답이 한 줄이라도 있어야. 비동기 연동 묶음은 고르지 않는다
  if (b.judge !== undefined && b.judge !== null && typeof b.judge !== 'boolean') return { ok: false, status: 400, message: 'AI 채점은 켜거나 끄는 값(true·false)으로 보내 주세요.' };
  const judge = b.judge === true && opts.source !== 'webhook';
  if (judge && !expects.some(Boolean)) return { ok: false, status: 400, message: BATCH_JUDGE_NEEDS_EXPECT };
  const errors: string[] = [];
  const checkedRows: Record<string, string>[] = [];
  b.rows.forEach((row, i) => {
    const checked = renderAppInput(definition.value!, row);
    if (!checked.ok) errors.push(`${i + 1}번째 줄: ${checked.message}`);
    else checkedRows.push({ ...checked.inputs });
  });
  if (errors.length) return { ok: false, status: 400, message: errors[0], errors: errors.slice(0, 10) };
  const inputs = fileMode ? pairRowsWithFiles(checkedRows, attachmentIds.length)!.map((row) => ({ ...row })) : checkedRows;
  const rowExpects = fileMode ? pairRowsWithFiles(expects, attachmentIds.length)! : expects;
  // 기관이 정한 한 번 최대 줄 수(0084) — 읽지 못하면 만들지 않는다(관리자가 낮춘 상한을 넘지 않게)
  let orgLimit: number | null;
  try { orgLimit = await readBatchLimit(actor.organizationId); } catch { return { ok: false, status: 503, message: '일괄 실행 설정을 확인하지 못했습니다. 잠시 뒤 다시 시도해 주세요.' }; }
  if (orgLimit !== null && inputs.length > orgLimit) return { ok: false, status: 400, message: `기관이 정한 일괄 실행 상한은 한 번에 ${orgLimit}줄입니다(지금 ${inputs.length}줄). 나눠서 실행해 주세요.` };
  // 기관이 정하지 않았으면 기본 100줄 — 수백 건은 기관 전체 관리자가 상한을 늘린 기관만(0123)
  if (orgLimit === null && inputs.length > BATCH_MAX_ROWS) return { ok: false, status: 400, message: `한 번에 ${BATCH_MAX_ROWS}줄까지 실행합니다(지금 ${inputs.length}줄). 더 많이 돌리려면 기관 관리자에게 일괄 실행 상한(${BATCH_ROWS_CEILING}줄까지)을 요청하세요.` };
  const name = normalizeBatchName(b.name) ?? `${agent.name.slice(0, 60)} 일괄 실행`;
  const { count, error: countError } = await supabaseAdmin.from('app_batches').select('id', { count: 'exact', head: true }).eq('user_id', actor.userId).eq('status', 'running');
  if (countError) return { ok: false, status: 503, message: '일괄 실행을 만들지 못했습니다. 잠시 뒤 다시 시도해 주세요.' };
  if ((count ?? 0) >= BATCH_MAX_RUNNING) return { ok: false, status: 409, message: `실행 중인 일괄 실행은 ${BATCH_MAX_RUNNING}개까지입니다. 끝나거나 그만둔 뒤 다시 만들어 주세요.` };
  // 고른 문서가 지금 이 사람이 고를 수 있는 문서인지(예약·연동과 같은 검사) — 못 읽으면 만들지 않는다
  const verified = await verifyChosenDocuments(agent.id, actor, documentIds);
  if (verified === 'error') return { ok: false, status: 503, message: '문서함 문서를 지금 확인하지 못했습니다. 잠시 뒤 다시 시도해 주세요.' };
  if (verified === 'unavailable') return { ok: false, status: 400, message: CHOSEN_DOCUMENTS_UNAVAILABLE };
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
    ...(judge ? { judge: true } : {}),
    ...(documentIds.length ? { document_ids: documentIds } : {}),
  }).select(BATCH_COLUMNS).single();
  if (error || !batch) return failCreate();
  const { error: itemError } = await supabaseAdmin.from('app_batch_items').insert(inputs.map((row, i) => ({ batch_id: batch.id, position: i + 1, inputs: row, ...(files[i] ? { file: files[i] } : {}), ...(rowExpects[i] ? { expect: rowExpects[i] } : {}) })));
  if (itemError) {
    await supabaseAdmin.from('app_batches').delete().eq('id', batch.id);
    return failCreate();
  }
  // 원본 첨부는 사본을 만들었으니 묘비로(보내지 않은 첨부 상한을 빨리 돌려준다 — 실행 때 다시 붙일 몫)
  if (fileMode) await discardAttachments(actor.userId, attachmentIds);
  return { ok: true, batch: batchView(batch as BatchRowView, agent.name, { done: 0, failed: 0, skipped: 0, pending: inputs.length }) };
}

type BatchRowView = { id: string; agent_id: string; name: string; status: BatchStatus; total: number; stop_reason: string | null; created_at: string; finished_at: string | null; judge?: boolean | null; document_ids?: string[] | null };
type Counts = { done: number; failed: number; skipped: number; pending: number; expectChecked?: number; expectPassed?: number; judgeCorrect?: number; judgePartial?: number; judgeIncorrect?: number; judgeErrors?: number; agreement?: BatchView['agreement'] };
const batchView = (r: BatchRowView, agentName: string | null, c: Counts): BatchView => ({
  id: r.id, agentId: r.agent_id, agentName, name: r.name, status: r.status, total: r.total, ...c, stopReason: r.stop_reason, createdAt: r.created_at, finishedAt: r.finished_at,
  ...(r.judge ? { judge: true } : {}),
  ...(r.document_ids?.length ? { documentCount: r.document_ids.length } : {}),
});

/** 줄 하나의 AI 채점을 수에 더한다 — 등급이 있으면 그 등급, 이유만 있으면 못 한 것 */
function countJudge(c: Counts, grade: unknown, reason: unknown): void {
  if (isBatchJudgeGrade(grade)) {
    if (grade === 'correct') c.judgeCorrect = (c.judgeCorrect ?? 0) + 1;
    else if (grade === 'partial') c.judgePartial = (c.judgePartial ?? 0) + 1;
    else c.judgeIncorrect = (c.judgeIncorrect ?? 0) + 1;
  } else if (typeof reason === 'string' && reason) c.judgeErrors = (c.judgeErrors ?? 0) + 1;
}

async function countsFor(batchIds: string[]): Promise<Map<string, Counts> | null> {
  const out = new Map<string, Counts>(batchIds.map((id) => [id, { done: 0, failed: 0, skipped: 0, pending: 0 }]));
  if (!batchIds.length) return out;
  // 묶음 20개 × 줄 500개는 API 1,000행 상한을 넘는다 — 쪽마다 끝까지(예전 `.limit(100 × 묶음 수)`는 1,000행에서 조용히 잘려 수가 덜 셌다, 2026-11-26)
  type CountRow = { batch_id: string; status: BatchItemStatus; expect_missing?: string[] | null; judge_grade?: string | null; judge_reason?: string | null; human_grade?: string | null };
  const { data, error } = await pagedRows<CountRow>((from, to, withCount) =>
    supabaseAdmin.from('app_batch_items').select('id, batch_id, status, expect_missing, judge_grade, judge_reason, human_grade', withCount ? { count: 'exact' } : undefined).in('batch_id', batchIds).order('id', { ascending: true }).range(from, to));
  if (error) return null;
  const graded = new Map<string, Array<{ judgeGrade: BatchJudgeGrade | null; humanGrade: BatchJudgeGrade | null }>>();
  for (const row of data as CountRow[]) {
    const c = out.get(row.batch_id);
    if (!c) continue;
    if (isBatchJudgeGrade(row.human_grade)) {
      const list = graded.get(row.batch_id) ?? [];
      list.push({ judgeGrade: isBatchJudgeGrade(row.judge_grade) ? row.judge_grade : null, humanGrade: row.human_grade });
      graded.set(row.batch_id, list);
    }
    if (row.status === 'done') c.done++; else if (row.status === 'failed') c.failed++; else if (row.status === 'skipped') c.skipped++; else c.pending++;
    if (Array.isArray(row.expect_missing)) { c.expectChecked = (c.expectChecked ?? 0) + 1; if (!row.expect_missing.length) c.expectPassed = (c.expectPassed ?? 0) + 1; }
    countJudge(c, row.judge_grade, row.judge_reason);
  }
  for (const [batchId, list] of graded) {
    const agreement = batchAgreement(list);
    if (agreement) out.get(batchId)!.agreement = agreement;
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

/** 일괄 실행을 못 읽었다 — '없음'(404)·'빈 묶음'으로 꾸미지 않는다(2026-11-18) */
export class BatchReadError extends Error {
  constructor() {
    super('batch read failed');
    this.name = 'BatchReadError';
  }
}

async function ownBatch(userId: string, id: string): Promise<(BatchRowView & { user_id: string }) | null> {
  if (!/^[0-9a-f-]{36}$/i.test(id)) return null;
  const { data, error } = await supabaseAdmin.from('app_batches').select(`${BATCH_COLUMNS}, user_id`).eq('id', id).eq('user_id', userId).maybeSingle();
  if (error) throw new BatchReadError();
  return (data as (BatchRowView & { user_id: string }) | null) ?? null;
}

/** 일괄 실행 하나와 줄들(입력·상태·오류·대화) — 만든 사람만 */
export async function getBatch(userId: string, id: string): Promise<{ batch: BatchView; items: BatchItemView[] } | null> {
  const batch = await ownBatch(userId, id);
  if (!batch) return null;
  const { data, error: itemsError } = await supabaseAdmin.from('app_batch_items').select('position, status, error, conversation_id, inputs, file, expect, expect_missing, judge_grade, judge_reason, human_grade').eq('batch_id', id).order('position', { ascending: true }).limit(BATCH_ROWS_CEILING);
  // 줄을 못 읽으면 '0줄'로 보이지 않는다 — 결과 엑셀이 빈 표로 내려갔다(2026-11-18)
  if (itemsError) throw new BatchReadError();
  const items = ((data ?? []) as Array<{ position: number; status: BatchItemStatus; error: string | null; conversation_id: string | null; inputs: Record<string, string>; file?: unknown; expect?: string | null; expect_missing?: string[] | null; judge_grade?: string | null; judge_reason?: string | null; human_grade?: string | null }>)
    .map((r) => ({
      position: r.position, status: r.status, error: r.error, conversationId: r.conversation_id, inputs: r.inputs ?? {}, fileName: batchFileOf(r.file)?.name ?? null, expect: r.expect ?? null, expectMissing: r.expect_missing ?? null,
      judgeGrade: isBatchJudgeGrade(r.judge_grade) ? r.judge_grade : null, judgeReason: r.judge_reason ?? null,
      humanGrade: isBatchJudgeGrade(r.human_grade) ? r.human_grade : null,
    }));
  const counts: Counts = { done: 0, failed: 0, skipped: 0, pending: 0 };
  for (const it of items) {
    if (it.status === 'done') counts.done++; else if (it.status === 'failed') counts.failed++; else if (it.status === 'skipped') counts.skipped++; else counts.pending++;
    if (it.expectMissing) { counts.expectChecked = (counts.expectChecked ?? 0) + 1; if (!it.expectMissing.length) counts.expectPassed = (counts.expectPassed ?? 0) + 1; }
    countJudge(counts, it.judgeGrade, it.judgeReason);
  }
  const agreement = batchAgreement(items);
  if (agreement) counts.agreement = agreement;
  const { data: agent } = await supabaseAdmin.from('agents').select('name').eq('id', batch.agent_id).maybeSingle();
  return { batch: batchView(batch, (agent as { name: string } | null)?.name ?? null, counts), items };
}

/**
 * 사람 판정(0126) — 만든 사람만, 마친 줄만. 등급을 남기거나(grade) 지운다(null). 한 줄 칸만 바꾸므로 두 번 눌러도 마지막 값이 남는다.
 * 바꾼 뒤 묶음을 다시 읽어(맞대기 포함) 돌려준다 — 다시 읽지 못하면 503(남긴 판정은 그대로)
 */
export async function labelBatchItem(userId: string, id: string, position: number, grade: BatchJudgeGrade | null, nowMs = Date.now()): Promise<{ ok: true; batch: BatchView; items: BatchItemView[] } | Fail> {
  const batch = await ownBatch(userId, id).catch((err) => { if (err instanceof BatchReadError) return 'failed' as const; throw err; });
  if (batch === 'failed') return { ok: false, status: 503, message: '일괄 실행을 지금 읽지 못했습니다. 잠시 뒤 다시 시도해 주세요.' };
  if (!batch) return { ok: false, status: 404, message: '일괄 실행을 찾을 수 없습니다.' };
  const { data, error } = await supabaseAdmin.from('app_batch_items')
    .update(grade ? { human_grade: grade, human_graded_at: new Date(nowMs).toISOString() } : { human_grade: null, human_graded_at: null })
    .eq('batch_id', id).eq('position', position).eq('status', 'done').select('position');
  if (error) return { ok: false, status: 503, message: '사람 판정을 저장하지 못했습니다. 잠시 뒤 다시 시도해 주세요.' };
  if (!data?.length) return { ok: false, status: 409, message: BATCH_HUMAN_ONLY_DONE };
  const out = await getBatch(userId, id).catch((err) => { if (err instanceof BatchReadError) return 'failed' as const; throw err; });
  if (out === 'failed' || !out) return { ok: false, status: 503, message: '사람 판정을 남겼지만 다시 읽지 못했습니다. 화면을 새로 고쳐 확인해 주세요.' };
  return { ok: true, ...out };
}

/** 그만두기 — 만든 사람만, 실행 중일 때만. 기다리던 줄은 건너뜀(이미 실행 중인 줄은 끝까지 간다) */
export async function cancelBatch(userId: string, id: string, nowMs = Date.now()): Promise<{ ok: true } | Fail> {
  const batch = await ownBatch(userId, id).catch((err) => { if (err instanceof BatchReadError) return 'failed' as const; throw err; });
  if (batch === 'failed') return { ok: false, status: 503, message: '일괄 실행을 지금 읽지 못했습니다. 잠시 뒤 다시 시도해 주세요.' };
  if (!batch) return { ok: false, status: 404, message: '일괄 실행을 찾을 수 없습니다.' };
  const now = new Date(nowMs).toISOString();
  const { data, error } = await supabaseAdmin.from('app_batches').update({ status: 'cancelled', finished_at: now }).eq('id', id).eq('user_id', userId).eq('status', 'running').select('id');
  if (error) return { ok: false, status: 503, message: '그만두지 못했습니다. 잠시 뒤 다시 시도해 주세요.' };
  if (!data?.length) return { ok: false, status: 409, message: '이미 끝났거나 멈춘 일괄 실행입니다.' };
  await skipPendingItems(id, now, '직원이 그만뒀습니다.');
  await removeBatchFiles(id).catch(() => undefined);
  return { ok: true };
}

export const PENDING_NOT_SKIPPED = '끝난 일괄 실행의 기다리던 줄을 건너뜀으로 바꾸지 못했습니다(대기로 남음 — 다시 실행에서 빠짐)';

/**
 * 끝낸(그만둠·멈춤) 묶음의 기다리던 줄을 건너뜀으로(2026-11-17). 실행기는 실행 중 묶음의 줄만 집어 해는 없지만, 바꾸지 못하면
 * 그 줄이 '대기'로 영영 남아 목록·엑셀 수가 틀리고 '마치지 못한 줄 다시 실행'(실패·건너뜀만)에서 빠진다 — 한 번 더 해 보고 운영 기록에.
 * 던지지 않는다
 */
export async function skipPendingItems(batchId: string, nowIso: string, reason: string): Promise<boolean> {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const { error } = await supabaseAdmin.from('app_batch_items').update({ status: 'skipped', finished_at: nowIso, error: reason.slice(0, 300) }).eq('batch_id', batchId).eq('status', 'pending');
      if (!error) return true;
      if (attempt === 1) await logSystem({ level: 'warning', category: 'database', message: PENDING_NOT_SKIPPED, details: { batch_id: batchId, code: error.code ?? 'error' } });
    } catch {
      if (attempt === 1) await logSystem({ level: 'warning', category: 'database', message: PENDING_NOT_SKIPPED, details: { batch_id: batchId, code: 'exception' } });
    }
  }
  return false;
}

/**
 * 마치지 못한 줄만 다시 실행(2026-11-10, 마이그레이션 없음) — 끝난 내 묶음(마침·멈춤·그만둠)의 실패·건너뛴 줄의 입력으로 **새 일괄 실행**을 만든다.
 * 만들기와 같은 길(`createBatch`)이라 지금 앱 판·앱 규칙·실행 중 3개·기관 상한을 그대로 본다. 파일마다 한 건의 줄은 사본을 이미 지워 다시 실행할 수 없어 빼고 수를 알린다
 */
export async function retryUnfinished(actor: ActorScope, batchId: string): Promise<{ ok: true; batch: BatchView; skippedFiles: number } | Fail | { ok: false; status: 400; message: string; errors: string[] }> {
  const batch = await ownBatch(actor.userId, batchId).catch((err) => { if (err instanceof BatchReadError) return 'failed' as const; throw err; });
  if (batch === 'failed') return { ok: false, status: 503, message: '일괄 실행을 지금 읽지 못했습니다. 잠시 뒤 다시 시도해 주세요.' };
  if (!batch) return { ok: false, status: 404, message: '일괄 실행을 찾을 수 없습니다.' };
  if (batch.status === 'running') return { ok: false, status: 409, message: '아직 실행 중인 일괄 실행입니다. 끝난 뒤에 다시 실행할 수 있습니다.' };
  const { data, error } = await supabaseAdmin.from('app_batch_items').select('position, inputs, file, status, expect').eq('batch_id', batchId).in('status', ['failed', 'skipped']).order('position', { ascending: true }).limit(BATCH_ROWS_CEILING);
  if (error) return { ok: false, status: 503, message: '줄을 불러오지 못했습니다. 잠시 뒤 다시 시도해 주세요.' };
  const rows = (data ?? []) as Array<{ position: number; inputs: Record<string, string>; file?: unknown; expect?: string | null }>;
  const tableRows = rows.filter((r) => r.file === null || r.file === undefined);
  const skippedFiles = rows.length - tableRows.length;
  if (!tableRows.length) return { ok: false, status: 409, message: skippedFiles ? '파일마다 한 건의 줄은 파일을 다시 올려 새로 실행해 주세요(사본은 일괄 실행이 끝날 때 지웠습니다).' : '다시 실행할 줄(실패·건너뜀)이 없습니다.' };
  // 고른 문서(0131) — 지금 근거 판으로 옮겨 새 묶음에. 쓸 판이 없으면 새로 고르게 한다
  let documentIds: string[] = [];
  if (batch.document_ids?.length) {
    if (!actor.organizationId) return { ok: false, status: 403, message: '소속 기관을 확인할 수 없습니다.' };
    let rows: LibraryDocumentRow[];
    try { rows = await agentDocumentRows(batch.agent_id, actor.organizationId); } catch { return { ok: false, status: 503, message: '문서함 문서를 지금 확인하지 못했습니다. 잠시 뒤 다시 시도해 주세요.' }; }
    const resolved = currentEditionIds(batch.document_ids, rows, batch.agent_id);
    if (!resolved.ok) return { ok: false, status: 409, message: '고른 문서함 문서를 더 쓸 수 없습니다(지워졌거나 근거로 쓸 판이 없음) — 문서를 다시 골라 새로 만들어 주세요.' };
    documentIds = resolved.ids;
  }
  const created = await createBatch(actor, { agent_id: batch.agent_id, name: `${batch.name.slice(0, 74)} 다시`, rows: tableRows.map((r) => r.inputs ?? {}), ...(documentIds.length ? { document_ids: documentIds } : {}), ...(tableRows.some((r) => r.expect) ? { expects: tableRows.map((r) => r.expect ?? ''), ...(batch.judge ? { judge: true } : {}) } : {}) });
  if (!created.ok) return created;
  return { ok: true, batch: created.batch, skippedFiles };
}

/** 끝난 묶음의 파일 사본 지우기(파일마다 한 건) — 줄의 파일 이름은 남긴다(결과 엑셀). 실패는 기록만, 던지지 않는다 */
export async function removeBatchFiles(batchId: string): Promise<void> {
  const { data, error } = await supabaseAdmin.from('app_batch_items').select('file').eq('batch_id', batchId).not('file', 'is', null).limit(BATCH_ROWS_CEILING);
  if (error) {
    await logSystem({ level: 'warning', category: 'database', message: '일괄 실행 파일 사본을 찾지 못했습니다 — 사본이 남았을 수 있음', details: { batch_id: batchId, error: error.message } }).catch(() => undefined);
    return;
  }
  const files = ((data ?? []) as Array<{ file: unknown }>).map((r) => batchFileOf(r.file)).filter((f): f is BatchFile => Boolean(f));
  await removeScheduleFileObjects(files, '일괄 실행이 끝난 뒤');
}

// ── 실행기 ─────────────────────────────────────────────────────────

export interface BatchRunRow { id: string; organization_id: string; department_id: string; user_id: string; agent_id: string; app_version: number; status: BatchStatus; webhook_id?: string | null; judge?: boolean | null; document_ids?: string[] | null }
export interface BatchItemRun { id: string; batch_id: string; position: number; inputs: Record<string, string>; status: 'pending' | 'running'; attempts: number; claimed_at: string | null; batch: BatchRunRow; file?: unknown; expect?: string | null }
export type ItemPatch = { status: 'done' | 'failed' | 'skipped' | 'pending'; attempts: number; error: string | null; conversation_id?: string | null; message_id?: string | null; expect_missing?: string[] | null; judge_grade?: BatchJudgeGrade | null; judge_reason?: string | null };
/** 비동기 연동 묶음(0087)의 줄이 끝났을 때 그 연동의 '마지막 결과' — 기다리는 호출의 `finish`와 같은 칸 */
export type WebhookResultPatch = { last_status: 'completed' | 'failed'; last_error: string | null; last_conversation_id: string | null };

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
  /** 그 실행의 답변 글(기대 핵심어를 잴 때만) — 못 읽으면 null(재지 않음) */
  resultText?(messageId: string): Promise<string | null>;
  /** AI 채점(0125) — AI 채점을 고른 묶음의 기대 답이 있는 줄만. 던지지 않는다 */
  judgeResult?(item: BatchItemRun, result: string): Promise<BatchJudgeResult>;
  /** 비동기 연동 묶음의 줄이 끝나면 그 연동의 마지막 결과를 바꾼다. 던져도 실행기는 이어 간다 */
  webhookResult?(webhookId: string, patch: WebhookResultPatch, nowIso: string): Promise<void>;
  log(message: string, details: Record<string, unknown>, orgId: string): Promise<void>;
}
export type BatchTick = { ran: number; done: number; failed: number; retried: number; stopped: number; notified: number; waited: number };

/** 시작 후 이 시간 안에서만 새 줄을 시작한다 — 실행 하나가 2분 남짓이라 함수 시간 제한(300초) 안에 끝나게 */
export const BATCH_START_WINDOW_MS = 90_000;
/** 줄 실행의 새 모델 호출 마감(시작 + 이만큼) */
export const BATCH_DEADLINE_MS = 150_000;
/** AI 채점(0125)을 시작할 수 있는 끝(실행기 시작 + 이만큼) — 함수 시간 제한(300초) 안에 채점 한 번(30초)이 끝나게 */
export const BATCH_JUDGE_LATEST_MS = 240_000;
/** 실행기 하나가 나란히 돌리는 줄 수(2026-11-26 — 2에서 3으로) */
export const BATCH_CONCURRENCY = 3;
/** 실행기 하나가 한 차례에 살펴볼 줄 수 */
export const BATCH_QUEUE_LIMIT = 40;
/** 쌓인 줄이 많을 때 5분 실행기가 더 띄우는 일괄 실행 전용 실행기 수의 끝(2026-11-26) — 실행기마다 `BATCH_CONCURRENCY`줄씩이라 한 번에 많아야 (1 + 이것) × 3줄 */
export const BATCH_EXTRA_LANES_MAX = 3;
/** 기다리는 줄이 이만큼 쌓일 때마다 실행기 하나를 더 띄운다 */
export const BATCH_ROWS_PER_LANE = 6;
/** 사용량 예약(0122)에 막혀 다음 차례로 미룬 줄에 적는 글 — 시도 횟수는 쓰지 않는다 */
export const BATCH_WAITING_RESERVATION = '실행 중인 다른 줄·앱이 사용량을 예약해 두어 다음 차례에 다시 실행합니다.';

/** 기다리는 줄 수 → 더 띄울 실행기 수(0~BATCH_EXTRA_LANES_MAX). 5분 실행기 자신이 한 몫을 돌리므로 그 몫을 뺀다 */
export function batchExtraLanes(pending: number): number {
  if (!Number.isFinite(pending) || pending <= BATCH_ROWS_PER_LANE) return 0;
  return Math.min(BATCH_EXTRA_LANES_MAX, Math.floor((pending - 1) / BATCH_ROWS_PER_LANE));
}

/**
 * 묶음을 번갈아(2026-11-26) — 줄을 묶음 순서대로 몰아 두면 500줄 묶음 하나가 실행기를 다 차지해 다른 직원의 묶음이 그 뒤로 밀린다.
 * 묶음마다 줄 순서를 지키고, 첫 줄들 → 둘째 줄들 → … 순으로 섞는다. `lane`만큼 앞에서 돌려 나란히 뜬 실행기가 같은 줄을 두고 겨루는 일을 줄인다
 */
export function interleaveBatchItems<T extends { batch_id: string; position: number }>(items: T[], batchOrder: string[], lane = 0): T[] {
  const groups = new Map<string, T[]>();
  for (const it of [...items].sort((a, b) => a.position - b.position)) {
    const g = groups.get(it.batch_id);
    if (g) g.push(it); else groups.set(it.batch_id, [it]);
  }
  const order = [...batchOrder.filter((id) => groups.has(id)), ...[...groups.keys()].filter((id) => !batchOrder.includes(id))];
  const out: T[] = [];
  for (let round = 0; out.length < items.length; round++) {
    for (const id of order) { const it = groups.get(id)![round]; if (it) out.push(it); }
  }
  const shift = out.length ? (Math.max(0, Math.floor(lane)) * BATCH_CONCURRENCY) % out.length : 0;
  return shift ? [...out.slice(shift), ...out.slice(0, shift)] : out;
}

/** 사용량 예약(0122)에 막혔지만 다른 실행이 예약을 풀면 될 거절 — 묶음을 멈추지 않고 다음 차례에 다시 */
const waitsForReservation = (outcome: RunAsOutcome): boolean => outcome.kind === 'rejected' && outcome.status === 429 && outcome.waitable === true;

const stopReasonFor = (outcome: RunAsOutcome): string | null => {
  if (outcome.kind === 'user_unavailable') return '직원 계정을 쓸 수 없어 멈췄습니다.';
  if (outcome.kind === 'department_changed') return '소속 부서가 바뀌어 멈췄습니다 — 새로 만들어 주세요.';
  if (outcome.kind !== 'rejected') return null;
  if (outcome.status === 409) return '앱 설정이 바뀌어 멈췄습니다 — 지금 앱으로 새로 만들어 주세요.';
  if (outcome.status === BATCH_DOCUMENTS_GONE_STATUS) return BATCH_DOCUMENTS_UNAVAILABLE;
  if (outcome.status === 403 || outcome.status === 404) return '앱을 더 쓸 수 없어 멈췄습니다.';
  if (outcome.status === 429) return `사용 한도에 걸려 멈췄습니다 — ${outcome.message}`.slice(0, 300);
  return null;
};

/** 차례가 된 줄을 세 줄씩 나란히(묶음을 번갈아). `lane` — 나란히 뜬 일괄 실행 전용 실행기의 번호(0 = 5분 실행기 자신). 던지지 않는다 */
export async function runDueBatchItems(deps: BatchDeps, opts: { lane?: number } = {}): Promise<BatchTick> {
  const start = deps.now();
  const tick: BatchTick = { ran: 0, done: 0, failed: 0, retried: 0, stopped: 0, notified: 0, waited: 0 };
  const iso = (ms: number) => new Date(ms).toISOString();
  let queue: BatchItemRun[];
  try { queue = (await deps.openItems(iso(start - BATCH_STALE_MS), BATCH_QUEUE_LIMIT)) ?? []; } catch { queue = []; }
  if (opts.lane) queue = interleaveBatchItems(queue, [...new Set(queue.map((it) => it.batch_id))], opts.lane);
  const stoppedBatches = new Set<string>();
  /** 사용량 예약에 막힌 묶음 — 이 차례에는 그 묶음의 줄을 더 시작하지 않는다(다음 차례에 다시) */
  const waitingBatches = new Set<string>();
  const notify = async (batch: BatchRunRow) => {
    if (deps.cleanup) await deps.cleanup(batch.id).catch(() => undefined);
    if (!deps.notifyFinished) return;
    try { if (await deps.notifyFinished(batch.id)) tick.notified++; } catch (error) {
      await deps.log('앱 일괄 실행 마침 메일을 보내지 못했습니다', { batch_id: batch.id, error: error instanceof Error ? error.message.slice(0, 200) : 'unknown' }, batch.organization_id).catch(() => {});
    }
  };
  const webhookResult = async (item: BatchItemRun, patch: WebhookResultPatch, nowIso: string) => {
    if (!item.batch.webhook_id || !deps.webhookResult) return;
    await deps.webhookResult(item.batch.webhook_id, patch, nowIso).catch(() => undefined);
  };
  // 줄 결과 저장 — 잠깐의 DB 오류에 한 번 더 해 본다(2026-11-12). 그래도 못 하면 기록만 남긴다: 줄이 `running`으로 남아 15분 뒤 다시 돌 수 있다(모델 비용 중복)
  const finish = async (item: BatchItemRun, patch: ItemPatch, nowIso: string) => {
    try { await deps.finishItem(item.id, patch, nowIso); return; } catch { /* 한 번 더 */ }
    try { await deps.finishItem(item.id, patch, nowIso); }
    catch (error) {
      await deps.log('앱 일괄 실행 줄 결과를 저장하지 못했습니다', { batch_id: item.batch_id, item_id: item.id, status: patch.status, error: error instanceof Error ? error.message.slice(0, 200) : 'unknown' }, item.batch.organization_id).catch(() => {});
    }
  };
  /** 기대 핵심어 재기와 AI 채점(0125) — 결과 글을 한 번 읽어 둘 다. 못 읽으면 재지 않음. 던지지 않는다 */
  const measure = async (item: BatchItemRun, messageId: string | undefined): Promise<Pick<ItemPatch, 'expect_missing' | 'judge_grade' | 'judge_reason'>> => {
    if (!item.expect || !messageId || !deps.resultText) return {};
    let text: string | null;
    try { text = await deps.resultText(messageId); } catch { text = null; }
    if (text === null) return {};
    const out: Pick<ItemPatch, 'expect_missing' | 'judge_grade' | 'judge_reason'> = { expect_missing: expectMissing(text, item.expect) };
    if (item.batch.judge && deps.judgeResult) {
      const judged = deps.now() - start > BATCH_JUDGE_LATEST_MS
        ? { grade: null, reason: BATCH_JUDGE_NO_TIME }
        : await deps.judgeResult(item, text).catch((): BatchJudgeResult => ({ grade: null, reason: 'AI 채점을 하지 못했습니다.' }));
      out.judge_grade = judged.grade;
      out.judge_reason = judged.reason.slice(0, 300) || null;
    }
    return out;
  };
  const worker = async () => {
    while (queue.length) {
      if (deps.now() - start > BATCH_START_WINDOW_MS) return;
      const item = queue.shift()!;
      if (stoppedBatches.has(item.batch_id) || waitingBatches.has(item.batch_id)) continue;
      const now = deps.now();
      if (!(await deps.claim(item, iso(now), iso(now - BATCH_STALE_MS)).catch(() => false))) continue;
      tick.ran++;
      const attempts = item.attempts + 1;
      let outcome: RunAsOutcome;
      try { outcome = await deps.run(item, start + BATCH_DEADLINE_MS); } catch (error) { outcome = { kind: 'failed', error: error instanceof Error ? error.message.slice(0, 300) : '알 수 없는 오류', conversationId: null }; }
      const doneAt = iso(deps.now());
      // 사용량 예약에 막혔지만 다른 실행이 예약을 쥐고 있다(같은 묶음의 다른 줄일 때가 많다) — 멈추지 않고 대기로 돌려 다음 차례에(시도 횟수는 그대로)
      if (waitsForReservation(outcome)) {
        await finish(item, { status: 'pending', attempts: item.attempts, error: BATCH_WAITING_RESERVATION }, doneAt);
        waitingBatches.add(item.batch_id);
        tick.waited++;
        continue;
      }
      const stopReason = stopReasonFor(outcome);
      if (stopReason) {
        await finish(item, { status: 'skipped', attempts, error: stopReason }, doneAt);
        await webhookResult(item, { last_status: 'failed', last_error: stopReason, last_conversation_id: null }, doneAt);
        const ended = await deps.stop(item.batch_id, stopReason, doneAt).catch(() => false);
        stoppedBatches.add(item.batch_id);
        tick.stopped++;
        await deps.log('앱 일괄 실행을 멈췄습니다', { batch_id: item.batch_id, reason: stopReason, kind: outcome.kind }, item.batch.organization_id).catch(() => {});
        if (ended === true) await notify(item.batch);
        continue;
      }
      if (outcome.kind === 'completed') {
        const measured = await measure(item, outcome.messageId);
        await finish(item, { status: 'done', attempts, error: null, conversation_id: outcome.conversationId, message_id: outcome.messageId ?? null, ...measured }, iso(deps.now()));
        await webhookResult(item, { last_status: 'completed', last_error: null, last_conversation_id: outcome.conversationId }, doneAt);
        tick.done++;
      } else if (outcome.kind === 'failed' && attempts < BATCH_MAX_ATTEMPTS) {
        await finish(item, { status: 'pending', attempts, error: outcome.error.slice(0, 300), conversation_id: outcome.conversationId }, doneAt);
        tick.retried++;
      } else {
        const error = outcome.kind === 'failed' ? outcome.error : outcome.kind === 'rejected' ? outcome.message : '실행하지 못했습니다.';
        await finish(item, { status: 'failed', attempts, error: error.slice(0, 300), ...(outcome.kind === 'failed' ? { conversation_id: outcome.conversationId } : {}) }, doneAt);
        await webhookResult(item, { last_status: 'failed', last_error: error.slice(0, 300), last_conversation_id: outcome.kind === 'failed' ? outcome.conversationId : null }, doneAt);
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
      const { data: batches, error } = await supabaseAdmin.from('app_batches').select('id, organization_id, department_id, user_id, agent_id, app_version, status, webhook_id, judge, document_ids')
        .eq('status', 'running').order('created_at', { ascending: true }).limit(20);
      if (error) return null;
      const byId = new Map(((batches ?? []) as BatchRunRow[]).map((b) => [b.id, b]));
      if (!byId.size) return [];
      const { data: items, error: itemError } = await supabaseAdmin.from('app_batch_items').select('id, batch_id, position, inputs, status, attempts, claimed_at, file, expect')
        .in('batch_id', [...byId.keys()])
        .or(`status.eq.pending,and(status.eq.running,claimed_at.lt.${staleIso})`)
        .order('position', { ascending: true }).limit(limit * 3);
      if (itemError) return null;
      // 묶음을 번갈아(먼저 만든 묶음부터 한 줄씩) — 큰 묶음 하나가 다른 직원의 묶음을 뒤로 밀지 않게(2026-11-26)
      return interleaveBatchItems(((items ?? []) as Array<Omit<BatchItemRun, 'batch'>>).map((it) => ({ ...it, batch: byId.get(it.batch_id)! })), [...byId.keys()])
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
      const { error } = await supabaseAdmin.from('app_batch_items').update({ ...patch, claimed_at: null, finished_at: terminal ? nowIso : null }).eq('id', id).eq('status', 'running');
      if (error) throw new Error(`app_batch_items finish: ${error.message}`);
    },
    async stop(batchId, reason, nowIso) {
      const { data, error } = await supabaseAdmin.from('app_batches').update({ status: 'stopped', stop_reason: reason, finished_at: nowIso }).eq('id', batchId).eq('status', 'running').select('id');
      // 묶음을 못 멈춘 채 줄만 건너뛰면 묶음이 곧 '마침'으로 바뀌어 멈춘 까닭이 사라진다 — 던져서 줄을 남기면 다음 차례에 그 줄이 같은 까닭으로 다시 멈추기를 해 본다(2026-11-17)
      if (error) throw new Error(`app_batches stop: ${error.message}`);
      await skipPendingItems(batchId, nowIso, reason);
      return Boolean(data?.length);
    },
    async settle(batchId, nowIso) {
      const { count, error } = await supabaseAdmin.from('app_batch_items').select('id', { count: 'exact', head: true }).eq('batch_id', batchId).in('status', ['pending', 'running']);
      if (error || (count ?? 0) > 0) return false;
      const { data, error: doneError } = await supabaseAdmin.from('app_batches').update({ status: 'done', finished_at: nowIso }).eq('id', batchId).eq('status', 'running').select('id');
      if (doneError) throw new Error(`app_batches settle: ${doneError.message}`);
      return Boolean(data?.length);
    },
    notifyFinished: (batchId) => notifyBatchFinished(batchId),
    cleanup: (batchId) => removeBatchFiles(batchId),
    async resultText(messageId) {
      const { data, error } = await supabaseAdmin.from('messages').select('content').eq('id', messageId).maybeSingle();
      if (error) return null;
      return (data as { content?: string } | null)?.content ?? null;
    },
    judgeResult: (item, result) => judgeBatchResult({
      batchId: item.batch_id, organizationId: item.batch.organization_id, departmentId: item.batch.department_id, userId: item.batch.user_id,
      agentId: item.batch.agent_id, inputs: item.inputs, expect: item.expect ?? '', result,
    }),
    async webhookResult(webhookId, patch, nowIso) {
      const { error } = await supabaseAdmin.from('app_webhooks').update({ ...patch, updated_at: nowIso }).eq('id', webhookId);
      if (error) throw new Error(`app_webhooks result: ${error.message}`);
    },
    async log(message, details, orgId) { await logSystem({ level: 'warning', category: 'api', message, details, orgId }); },
  };
}

export interface BatchRunIo {
  files: ScheduleFileIo;
  runAs(input: Parameters<typeof runAppAs>[0]): Promise<RunAsOutcome>;
  /** 그 비서의 문서 행(0131 — 고른 문서의 지금 판). 없으면 `agentDocumentRows` */
  documentsOf?(agentId: string, organizationId: string): Promise<LibraryDocumentRow[]>;
}
const defaultBatchRunIo = (): BatchRunIo => ({ files: defaultScheduleFileIo, runAs: (input) => runAppAs(input, BATCH_TITLE_PREFIX, defaultRunAsIo()) });

/**
 * 줄 하나 실행 — 파일마다 한 건이면 그 줄의 사본을 새 첨부로 다시 붙여 함께 실행한다.
 * 사본을 못 불러오면 '실패'(한 번 더 해 봄), 사본이 없거나 붙인 파일을 읽지 못하면 그 줄만 실패(400 — 다시 해도 같음). 시작 전에 끝났으면 붙인 첨부를 묘비로
 */
export async function runBatchItem(item: BatchItemRun, deadlineAt: number, io: BatchRunIo = defaultBatchRunIo()): Promise<RunAsOutcome> {
  const actor = { userId: item.batch.user_id, departmentId: item.batch.department_id, organizationId: item.batch.organization_id };
  // 고른 문서(0131) — 줄마다 지금 근거 판으로(시행일이 지나면 새 판). 못 읽으면 그 줄만 다시 해 보고, 쓸 판이 없으면 묶음을 멈춘다
  let documentIds: string[] | undefined;
  if (item.batch.document_ids?.length) {
    let rows: LibraryDocumentRow[];
    try { rows = await (io.documentsOf ?? agentDocumentRows)(item.batch.agent_id, actor.organizationId); } catch { return { kind: 'failed', error: '문서함 문서를 지금 읽지 못했습니다(잠시 뒤 다시).', conversationId: null }; }
    const resolved = currentEditionIds(item.batch.document_ids, rows, item.batch.agent_id);
    if (!resolved.ok) return { kind: 'rejected', status: BATCH_DOCUMENTS_GONE_STATUS, message: BATCH_DOCUMENTS_UNAVAILABLE };
    documentIds = resolved.ids;
  }
  const base = { userId: actor.userId, departmentId: actor.departmentId, agentId: item.batch.agent_id, appVersion: item.batch.app_version, inputs: item.inputs, deadlineAt, ...(documentIds ? { documentIds } : {}) };
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
      // 받는 사람·확인 기다림 수를 못 읽으면 던진다(실행기가 '마침 메일을 보내지 못했습니다'로 기록) — 2026-11-20, 예전엔 주소 읽기 실패를
      // '주소 없음'으로 보아 메일 없이 조용히 끝났고, 확인 기다림 수 읽기 실패는 메일에 0건으로 적혔다(보내기 전 확인할 결과가 있어도)
      const [{ data: items, error: itemError }, { data: user, error: userError }, { data: agent }] = await Promise.all([
        supabaseAdmin.from('app_batch_items').select('status, message_id').eq('batch_id', batchId),
        supabaseAdmin.from('users').select('email').eq('id', b.user_id).maybeSingle(),
        supabaseAdmin.from('agents').select('name').eq('id', b.agent_id).maybeSingle(),
      ]);
      if (itemError) throw new Error(itemError.message);
      if (userError) throw new Error(`users: ${userError.message}`);
      const rows = (items ?? []) as Array<{ status: string; message_id: string | null }>;
      const messageIds = rows.map((r) => r.message_id).filter((v): v is string => typeof v === 'string');
      let awaitingApproval = 0;
      if (messageIds.length) {
        // 이 묶음의 답변 중 보내기 전 확인(0078)을 기다리는 것 — 그 직원의 기록만
        for (const ids of idChunks(messageIds)) {
          const { count, error: countError } = await supabaseAdmin.from('app_outbound_deliveries').select('id', { count: 'exact', head: true })
            .eq('user_id', b.user_id).eq('status', 'awaiting_approval').in('message_id', ids);
          if (countError) throw new Error(`app_outbound_deliveries: ${countError.message}`);
          awaitingApproval += count ?? 0;
        }
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
  const withExpect = input.items.some((it) => it.expect);
  const withJudge = input.items.some((it) => it.judgeGrade || it.judgeReason);
  const withHuman = input.items.some((it) => it.humanGrade);
  sheet.addRow(['번호', ...(withFile ? ['파일'] : []), ...input.fields.map((f) => safeText(f.label)), '상태', '결과', '오류', '대화', ...(withDelivery ? ['보내기', '접수 번호'] : []), ...(withExpect ? ['기대 핵심어', '핵심어 판정'] : []), ...(withJudge ? ['AI 채점(참고)'] : []), ...(withHuman ? ['사람 판정'] : [])]);
  sheet.getRow(1).font = { bold: true };
  sheet.views = [{ state: 'frozen', ySplit: 1 }];
  for (const it of input.items) {
    sheet.addRow([
      it.position, ...(withFile ? [safeText(it.fileName ?? '')] : []), ...input.fields.map((f) => safeText(it.inputs[f.key] ?? '')), BATCH_ITEM_STATUS_LABELS[it.status],
      safeText(it.result ?? ''), safeText(it.error ?? ''), it.conversationId ? `${input.origin}/chat?conv=${it.conversationId}` : '',
      ...(withDelivery ? [it.delivery ? OUTBOUND_STATUS_LABELS[it.delivery.status] ?? it.delivery.status : '', safeText(it.delivery?.receiptRef ?? '')] : []),
      ...(withExpect ? [safeText(it.expect ?? ''), safeText(expectVerdict(it.expect, it.status === 'done' ? it.expectMissing : null))] : []),
      ...(withJudge ? [safeText(judgeVerdict(it.judgeGrade, it.judgeReason))] : []),
      ...(withHuman ? [it.humanGrade ? BATCH_JUDGE_LABELS[it.humanGrade] : ''] : []),
    ]);
  }
  const lead = withFile ? 1 : 0;
  sheet.columns.forEach((col, i) => { col.width = i === 0 ? 6 : i === input.fields.length + lead + 2 ? 80 : 20; });
  sheet.getColumn(input.fields.length + lead + 3).alignment = { wrapText: true, vertical: 'top' };
  return Buffer.from(await workbook.xlsx.writeBuffer());
}

/** 엑셀에 넣을 줄마다 보내기 상태·접수 번호 — 만든 사람의 보내기 기록만(그 실행의 답변 메시지로 맞춤). 못 읽으면 null(열 없이) */
export async function loadBatchDeliveries(userId: string, batchId: string): Promise<Map<number, BatchDeliveryCell> | null> {
  const { data, error } = await supabaseAdmin.from('app_batch_items').select('position, message_id').eq('batch_id', batchId).not('message_id', 'is', null).limit(BATCH_ROWS_CEILING);
  if (error) return null;
  const rows = (data ?? []) as Array<{ position: number; message_id: string }>;
  if (!rows.length) return new Map();
  const deliveries: unknown[] = [];
  for (const ids of idChunks(rows.map((r) => r.message_id))) {
    const { data: part, error: dErr } = await supabaseAdmin.from('app_outbound_deliveries').select('message_id, status, receipt_ref, created_at')
      .eq('user_id', userId).in('message_id', ids).order('created_at', { ascending: true });
    if (dErr) return null;
    deliveries.push(...(part ?? []));
  }
  // 같은 답변을 두 곳으로 보냈으면 나중 기록(조각마다 시각 순이라 다시 맞춘다)
  (deliveries as Array<{ created_at?: string }>).sort((a, b) => String(a.created_at ?? '').localeCompare(String(b.created_at ?? '')));
  const byMessage = new Map((deliveries as Array<{ message_id: string; status: OutboundStatus; receipt_ref: string | null }>).map((d) => [d.message_id, { status: d.status, receiptRef: d.receipt_ref ?? null }]));
  return new Map(rows.filter((r) => byMessage.has(r.message_id)).map((r) => [r.position, byMessage.get(r.message_id)!]));
}

/** 엑셀에 넣을 줄마다 결과 글 — 그 실행의 답변 메시지(만든 사람의 대화만) */
export async function loadBatchResults(userId: string, batchId: string): Promise<Map<number, string> | null> {
  const { data, error } = await supabaseAdmin.from('app_batch_items').select('position, message_id').eq('batch_id', batchId).not('message_id', 'is', null).limit(BATCH_ROWS_CEILING);
  if (error) return null;
  const rows = (data ?? []) as Array<{ position: number; message_id: string }>;
  if (!rows.length) return new Map();
  const messages: unknown[] = [];
  for (const ids of idChunks(rows.map((r) => r.message_id))) {
    const { data: part, error: messageError } = await supabaseAdmin.from('messages').select('id, content, conversation:conversations!inner(user_id)')
      .in('id', ids).eq('conversation.user_id', userId);
    if (messageError) return null;
    messages.push(...(part ?? []));
  }
  const text = new Map((messages as Array<{ id: string; content: string }>).map((m) => [m.id, m.content]));
  return new Map(rows.filter((r) => text.has(r.message_id)).map((r) => [r.position, text.get(r.message_id)!]));
}
