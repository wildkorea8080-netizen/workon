// src/lib/work/services.ts
import { createHash } from 'crypto';
import type { WorkContext } from './context';
import { taskAccess, type TaskAccess } from './access';
import { getWorkflow, isWorkflowKey, CATALOG_VERSION } from './catalog';
import { getWorkflowImpl, summarizeWorkflows, definitionFor, outputKeysOf } from './workflows';
import { checkForm } from './workflows/form';
import { applyPatches, mergeGenerated, normalizeStoredFields, parsePatches } from './documents/fields';
import { ensureBuiltinTemplateVersion, templateLabel } from './documents/templates';
import { BUILTIN_TEMPLATES } from '@/lib/builtin-templates';
import { satisfiesFileSet } from './file-sets';
import { disabledWorkflows } from './admin';
import type { RegulationContent, ItemsContent, QaContent } from './runs/executor';
import type { SettlementResult } from './workflows/settlement/reconcile';
import type { QaResult } from './workflows/qa/verify';
import { artifactDto } from './artifacts';
import { sourceDto, copyArtifactToSource, copyBytesToSource } from './sources';
import { WorkError, type WorkActor, type WorkTaskRow, type WorkRunRow, type DocumentField } from './types';
import type { TemplateVersionRow } from './store/types';

/**
 * 업무 서비스 — 라우트가 부르는 입구. **모든 입구가 여기서 권한을 다시 본다**(access.ts).
 * 권한이 없으면 내용을 드러내지 않는다: 읽을 수 없으면 404, 읽을 수 있지만 바꿀 수 없으면 403.
 */
export const DOWNLOAD_URL_TTL_SECONDS = 60;

export async function loadTask(ctx: WorkContext, actor: WorkActor, taskId: string, need: 'read' | 'edit' | 'review' | 'download' = 'read') {
  if (!/^[0-9a-f-]{36}$/i.test(taskId)) throw new WorkError('NOT_FOUND', '작업을 찾을 수 없습니다.', 404);
  const task = await ctx.store.getTask(taskId, actor.organizationId);
  if (!task) throw new WorkError('NOT_FOUND', '작업을 찾을 수 없습니다.', 404);
  const members = await ctx.store.getMembers(task.id);
  const access = taskAccess(task, actor, members);
  if (!access.read) throw new WorkError('NOT_FOUND', '작업을 찾을 수 없습니다.', 404);
  if (need !== 'read' && !access[need]) throw new WorkError('FORBIDDEN', '이 작업을 바꿀 권한이 없습니다.', 403);
  return { task, access };
}

async function requireNewTasksEnabled(ctx: WorkContext, actor: WorkActor) {
  const s = await ctx.store.getOrgSettings(actor.organizationId);
  if (!s.newTasksEnabled) throw new WorkError('FEATURE_DISABLED', '이 기관은 아직 새 업무 작업을 쓸 수 없습니다. 기관 관리자에게 문의하세요.', 403);
}

function hashPayload(v: unknown): string {
  return createHash('sha256').update(JSON.stringify(v)).digest('hex');
}

function cleanKey(key: unknown): string {
  if (typeof key !== 'string' || !/^[A-Za-z0-9_-]{8,128}$/.test(key)) throw new WorkError('INVALID_INPUT', '요청 번호(Idempotency-Key)가 올바르지 않습니다.');
  return key;
}

export async function listWorkflowsForActor(ctx: WorkContext, actor: WorkActor) {
  const [settings, off] = await Promise.all([ctx.store.getOrgSettings(actor.organizationId), disabledWorkflows(ctx, actor.organizationId)]);
  // 기관 관리자가 끈 업무는 목록에 남기되 시작할 수 없게(이미 만든 작업은 그대로 열린다)
  const workflows = summarizeWorkflows().map((w) => (off.has(w.key) && w.available ? { ...w, available: false, reason: '기관에서 이 업무를 쓰지 않도록 설정했습니다.' } : w));
  return { settings, workflows };
}

export async function listTemplates(ctx: WorkContext, actor: WorkActor) {
  // 표준 양식은 파일이 있으면 판 행을 맞춰 둔다(없으면 '준비 안 됨'으로)
  const builtin: { ref: string; name: string; status: string; label: string; id: string | null; reason: string | null }[] = [];
  for (const ref of BUILTIN_TEMPLATES.map((t) => t.ref)) {
    try {
      const tv = await ensureBuiltinTemplateVersion(ctx.store, ref);
      builtin.push({ ref, name: tv.name, status: tv.status, label: templateLabel(tv), id: tv.id, reason: null });
    } catch (e) {
      builtin.push({ ref, name: ref, status: 'missing', label: '파일 없음', id: null, reason: e instanceof WorkError ? e.message : '불러오지 못함' });
    }
  }
  const org = (await ctx.store.listTemplateVersions(actor.organizationId)).filter((t) => t.organization_id);
  return { builtin, organization: org.map(templateDto) };
}

export function templateDto(t: TemplateVersionRow) {
  return {
    id: t.id,
    name: t.name,
    source: t.source,
    format: t.format,
    version: t.version,
    status: t.status,
    label: templateLabel(t),
    supported: t.supported,
    fieldCount: t.manifest.slots?.length ?? 0,
    verified: t.verification ? true : false,
  };
}

export interface CreateTaskInput {
  workflowKey: unknown;
  title: unknown;
  form?: unknown;
  templateVersionId?: unknown;
  dueDate?: unknown;
}

export async function createTask(ctx: WorkContext, actor: WorkActor, input: CreateTaskInput): Promise<WorkTaskRow> {
  await requireNewTasksEnabled(ctx, actor);
  if (!isWorkflowKey(input.workflowKey)) throw new WorkError('INVALID_INPUT', '알 수 없는 업무입니다.');
  const impl = getWorkflowImpl(input.workflowKey);
  if (!impl) throw new WorkError('WORKFLOW_NOT_READY', '이 업무는 아직 준비 중입니다.', 409);
  if ((await disabledWorkflows(ctx, actor.organizationId)).has(input.workflowKey)) throw new WorkError('FEATURE_DISABLED', '기관에서 이 업무를 쓰지 않도록 설정했습니다. 기관 관리자에게 문의하세요.', 403);
  const def = getWorkflow(input.workflowKey)!;
  const title = typeof input.title === 'string' ? input.title.replace(/\s+/g, ' ').trim() : '';
  if (!title || title.length > 200) throw new WorkError('INVALID_INPUT', '작업 제목을 1~200자로 적어 주세요.');
  // 업무 입력에 '제목'이 있으면 작업 제목과 같은 값이다(따로 두 번 적게 하지 않는다)
  const rawForm = { ...((input.form ?? {}) as Record<string, unknown>) };
  if (def.inputs.some((i) => i.key === 'title') && !rawForm.title) rawForm.title = title;
  const dueDate = typeof input.dueDate === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(input.dueDate) ? input.dueDate : null;

  // 양식이 있는 업무만 양식을 고른다(취합·접수는 양식 없이 엑셀을 만든다)
  let tv: TemplateVersionRow | null = null;
  if (impl.defaultTemplateRef) {
    if (typeof input.templateVersionId === 'string' && input.templateVersionId) {
      const found = await ctx.store.getTemplateVersion(input.templateVersionId, actor.organizationId);
      if (!found || found.status === 'retired') throw new WorkError('TEMPLATE_MISSING', '고른 양식을 쓸 수 없습니다.', 404);
      tv = found;
    } else {
      tv = await ensureBuiltinTemplateVersion(ctx.store, impl.defaultTemplateRef!);
    }
    if (tv.status === 'draft') throw new WorkError('TEMPLATE_UNSUPPORTED', '이 양식은 아직 검증 전이라 쓸 수 없습니다.', 409);
  }
  // 양식 입력은 서버가 고른 판으로 정한다(클라이언트가 보낸 값을 그대로 믿지 않는다)
  const form = checkForm(def, tv ? { ...rawForm, templateVersion: tv.id } : rawForm);

  const task = await ctx.store.insertTask({
    organization_id: actor.organizationId,
    department_id: actor.departmentId,
    owner_id: actor.userId,
    workflow_key: input.workflowKey,
    workflow_version: CATALOG_VERSION,
    title,
    form: form.values,
    template_version_id: tv?.id ?? null,
    due_date: dueDate,
    status: requiredReady(def, form.missing.length, []) ? 'ready' : 'draft',
  });
  await ctx.store.insertEvent({ organizationId: task.organization_id, taskId: task.id, actorId: actor.userId, type: 'task.created', details: { workflow_key: task.workflow_key } });
  return task;
}

/** 원자료가 읽힌 뒤 — 필수 입력·필수 원자료가 다 있으면 draft → ready(처리 중·검토 단계는 건드리지 않는다) */
export async function refreshReadiness(ctx: WorkContext, task: WorkTaskRow): Promise<void> {
  if (task.status !== 'draft' && task.status !== 'ready') return;
  const def = definitionFor(task.workflow_key);
  const form = checkForm(def, task.form);
  const sources = await ctx.store.listSources(task.id, task.organization_id);
  const next = requiredReady(def, form.missing.length, sources.filter((s) => s.status === 'ready').map((s) => s.purpose)) ? 'ready' : 'draft';
  if (next !== task.status) await ctx.store.setTaskStatus(task.id, task.organization_id, next);
}

/** 필수 폼 입력이 다 있고, 필수 파일 입력마다 그 용도의 읽힌 원자료가 하나 이상이면 ready(정산: 예산·집행 + 증빙 + 기준) */
function requiredReady(def: ReturnType<typeof definitionFor>, missingForm: number, readyPurposes: string[]): boolean {
  const sets = def.inputs.filter((i) => i.type === 'file-set' && i.required);
  return missingForm === 0 && sets.every((i) => readyPurposes.some((p) => satisfiesFileSet(i.key, p)));
}

export async function listTasks(ctx: WorkContext, actor: WorkActor, q: { status?: string[]; workflowKey?: string; cursor?: string | null; limit?: number }) {
  let before: { updatedAt: string; id: string } | null = null;
  if (q.cursor) {
    const [updatedAt, id] = Buffer.from(q.cursor, 'base64url').toString('utf8').split('|');
    if (updatedAt && /^[0-9a-f-]{36}$/i.test(id ?? '') && !Number.isNaN(Date.parse(updatedAt))) before = { updatedAt, id };
  }
  const limit = Math.min(Math.max(q.limit ?? 20, 1), 50);
  const rows = await ctx.store.listTasks({ organizationId: actor.organizationId, userId: actor.userId, status: q.status, workflowKey: q.workflowKey, limit, before });
  const last = rows[rows.length - 1];
  return {
    items: rows.map((t) => taskDto(t, taskAccess(t, actor, t.owner_id === actor.userId ? [] : [{ user_id: actor.userId, role: 'viewer' }]))),
    nextCursor: rows.length === limit && last ? Buffer.from(`${last.updated_at}|${last.id}`).toString('base64url') : null,
  };
}

export function taskDto(t: WorkTaskRow, access: TaskAccess) {
  const def = getWorkflow(t.workflow_key);
  return {
    id: t.id,
    title: t.title,
    workflowKey: t.workflow_key,
    workflowName: def?.name ?? t.workflow_key,
    status: t.status,
    revision: t.revision,
    dueDate: t.due_date,
    form: t.form,
    templateVersionId: t.template_version_id,
    currentDocumentVersionId: t.current_document_version_id,
    currentRunId: t.current_run_id,
    approvedVersionId: t.approved_version_id,
    approvedAt: t.approved_at,
    isOwner: access.isOwner,
    role: access.role,
    access: { edit: access.edit, review: access.review, download: access.download },
    createdAt: t.created_at,
    updatedAt: t.updated_at,
  };
}

export function runDto(r: WorkRunRow) {
  return {
    id: r.id,
    operation: r.operation,
    status: r.status,
    attempt: r.attempt,
    maxAttempts: r.max_attempts,
    error: r.error ? { code: r.error.code, message: r.error.safeMessage, retryable: r.error.retryable } : null,
    result: r.result,
    cancelRequested: Boolean(r.cancel_requested_at),
    createdAt: r.created_at,
    startedAt: r.started_at,
    finishedAt: r.finished_at,
  };
}

export async function getTaskDetail(ctx: WorkContext, actor: WorkActor, taskId: string) {
  const { task, access } = await loadTask(ctx, actor, taskId);
  const def = definitionFor(task.workflow_key);
  const [version, artifacts, sources, currentRun, activeRun, tv] = await Promise.all([
    task.current_document_version_id ? ctx.store.getVersion(task.current_document_version_id, task.organization_id) : null,
    ctx.store.listArtifacts(task.id, task.organization_id),
    ctx.store.listSources(task.id, task.organization_id),
    task.current_run_id ? ctx.store.getRun(task.current_run_id, task.organization_id) : null,
    ctx.store.getActiveRun(task.id, task.organization_id),
    task.template_version_id ? ctx.store.getTemplateVersion(task.template_version_id, task.organization_id) : null,
  ]);
  // 끝나지 않은 실행(저장·복구가 건 파일 만들기 포함)이 먼저, 없으면 마지막 '파일 만들기' 결과
  const run = activeRun ?? currentRun;
  const review = version ? await ctx.store.listReviewItems(version.id, task.organization_id) : [];
  // 지금 판의 결과 파일 — 주 결과가 먼저(머리의 '내려받기'가 주 결과를 가리키게), 그다음 함께 만든 파일 순
  const order = (() => {
    const impl = getWorkflowImpl(task.workflow_key);
    return impl ? outputKeysOf(impl) : [];
  })();
  const rank = (k: string) => (order.indexOf(k) < 0 ? order.length : order.indexOf(k));
  const currentArtifacts = version ? artifacts.filter((a) => a.document_version_id === version.id).sort((x, y) => rank(x.output_key) - rank(y.output_key)) : [];
  return {
    task: taskDto(task, access),
    kind: getWorkflowImpl(task.workflow_key)?.kind ?? 'document',
    workflow: { key: def.key, name: def.name, purpose: def.purpose, inputs: def.inputs, outputs: def.outputs, scopeNote: def.scopeNote, validationRules: def.validationRules },
    template: tv ? templateDto(tv) : null,
    version: version
      ? {
          id: version.id,
          version: version.version,
          origin: version.origin,
          changeReason: version.change_reason,
          createdAt: version.created_at,
          fields: normalizeStoredFields(version.fields),
          // 취합 결과(부서·합계·원본 대응) — 원자료 저장 경로는 없다
          collection: (version.content as { result?: unknown } | null)?.result ?? null,
          // 규정 확인 — 그 판이 찾은 근거·적용 판정·유보(보관함·파일 이름 앞부분 없음)
          regulations: regulationsDto((version.content as { regulations?: RegulationContent } | null)?.regulations),
          // 뽑은 항목(접수·회의·인수인계) — 원문 인용·확인 표시 그대로
          items: itemsDto((version.content as { items?: ItemsContent } | null)?.items),
          // 대사 결과(거래·증빙·잔액) — 원자료 경로 없음
          settlement: (version.content as { settlement?: SettlementResult } | null)?.settlement ?? null,
          // 질문별 답변(근거·확인 표시)
          qa: ((version.content as { qa?: QaContent } | null)?.qa?.result as QaResult | undefined) ?? null,
        }
      : null,
    review: review.map((r) => ({ id: r.id, severity: r.severity, code: r.code, message: r.message, fieldIds: r.field_ids, state: r.state, resolutionNote: r.resolution_note })),
    artifacts: artifacts.map((a) => ({ ...artifactDto(a), current: Boolean(version && a.document_version_id === version.id) })),
    currentArtifacts: currentArtifacts.map(artifactDto),
    sources: sources.filter((s) => s.status !== 'failed' || s.failure_reason).map(sourceDto),
    run: run ? runDto(run) : null,
    generatorMode: ctx.generatorMode,
    // 실제로 만드는 결과 파일 키(카탈로그 outputs 중 구현된 것 — 선택 산출물을 아직 안 만들면 빠진다)
    producedOutputs: order,
  };
}

function itemsDto(c: ItemsContent | undefined) {
  if (!c || c.schema !== 'items/1') return null;
  return {
    name: c.name,
    columns: c.columns,
    typeLabel: c.typeLabel,
    items: c.items.map((i) => ({ id: i.id, type: i.type, values: i.values, sourceName: i.sourceName, quote: i.quote, flags: i.flags, notes: i.notes })),
    meta: c.meta,
    extra: c.extra ?? null,
  };
}

function regulationsDto(c: RegulationContent | undefined) {
  if (!c || c.schema !== 'regulations/1') return null;
  return {
    basisDate: c.basisDate,
    mode: c.mode,
    unavailable: c.unavailable,
    findings: c.outcome.findings,
    reservations: c.outcome.reservations,
    evidence: c.evidence.map((e) => ({
      id: e.id,
      kind: e.kind,
      title: e.title,
      location: e.location,
      effectiveDate: e.effectiveDate,
      editionYear: e.editionYear,
      applicability: e.applicability,
      note: e.note,
      text: e.text,
      url: e.url && /^https:\/\/www\.law\.go\.kr\//.test(e.url) ? e.url : null,
    })),
  };
}

export async function updateTaskMeta(ctx: WorkContext, actor: WorkActor, taskId: string, input: { revision: unknown; title?: unknown; dueDate?: unknown; form?: unknown }) {
  const { task } = await loadTask(ctx, actor, taskId, 'edit');
  if (typeof input.revision !== 'number') throw new WorkError('INVALID_INPUT', 'revision이 필요합니다.');
  if (task.status === 'processing') throw new WorkError('VERSION_CONFLICT', '처리 중에는 입력을 바꿀 수 없습니다.', 409);
  const patch: Partial<WorkTaskRow> = {};
  if (input.title !== undefined) {
    const title = typeof input.title === 'string' ? input.title.replace(/\s+/g, ' ').trim() : '';
    if (!title || title.length > 200) throw new WorkError('INVALID_INPUT', '작업 제목을 1~200자로 적어 주세요.');
    patch.title = title;
    const def = definitionFor(task.workflow_key);
    if (def.inputs.some((i) => i.key === 'title') && input.form === undefined) patch.form = { ...task.form, title };
  }
  if (input.dueDate !== undefined) patch.due_date = typeof input.dueDate === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(input.dueDate) ? input.dueDate : null;
  if (input.form !== undefined) {
    const def = definitionFor(task.workflow_key);
    const { templateVersion: _ignored, ...rest } = (input.form ?? {}) as Record<string, unknown>;
    // 양식은 작업을 만들 때 고정된다 — 폼으로 바꾸지 않고 작업의 양식 판을 그대로 둔다
    const form = checkForm(def, task.template_version_id ? { ...rest, templateVersion: task.template_version_id } : rest);
    patch.form = task.template_version_id ? { ...form.values, templateVersion: task.template_version_id } : form.values;
    const sources = await ctx.store.listSources(task.id, task.organization_id);
    if (task.status === 'draft' || task.status === 'ready') {
      patch.status = requiredReady(def, form.missing.length, sources.filter((s) => s.status === 'ready').map((s) => s.purpose)) ? 'ready' : 'draft';
    }
  }
  const updated = await ctx.store.updateTaskIfRevision(task.id, task.organization_id, input.revision, patch);
  if (!updated) throw new WorkError('VERSION_CONFLICT', '그 사이 작업이 바뀌었습니다. 새로고침한 뒤 다시 저장해 주세요.', 409);
  return updated;
}

async function currentVersionNumber(ctx: WorkContext, task: WorkTaskRow): Promise<{ number: number; id: string | null; fields: DocumentField[]; content: Record<string, unknown> | null }> {
  if (!task.current_document_version_id) return { number: 0, id: null, fields: [], content: null };
  const v = await ctx.store.getVersion(task.current_document_version_id, task.organization_id);
  return { number: v?.version ?? 0, id: v?.id ?? null, fields: normalizeStoredFields(v?.fields), content: (v?.content as Record<string, unknown> | null) ?? null };
}

/** 칸만 고친 새 판이 이어 받는 내용 — 규정 판의 근거·판정(무엇을 보고 썼나)은 칸을 고쳐도 그대로다 */
function carriedContent(content: Record<string, unknown> | null): Record<string, unknown> | null {
  if (!content) return null;
  if ('regulations' in content) return { regulations: content.regulations };
  if ('items' in content) return { items: content.items };
  if ('qa' in content) return { qa: content.qa };
  return null;
}

/** '파일 만들기' — 초안 생성 실행. 같은 요청 번호면 같은 실행(연속 클릭 — A11) */
export async function requestGenerate(ctx: WorkContext, actor: WorkActor, taskId: string, input: { baseVersion: unknown; idempotencyKey: unknown; decisions?: unknown }) {
  await requireNewTasksEnabled(ctx, actor);
  const { task } = await loadTask(ctx, actor, taskId, 'edit');
  const key = cleanKey(input.idempotencyKey);
  const cur = await currentVersionNumber(ctx, task);
  if (input.baseVersion !== cur.number) throw new WorkError('VERSION_CONFLICT', '그 사이 문서가 바뀌었습니다. 새로고침해 주세요.', 409, { currentVersion: cur.number });
  const def = definitionFor(task.workflow_key);
  const form = checkForm(def, task.form);
  if (form.missing.length) throw new WorkError('REQUIRED_INPUT_MISSING', `필수 입력을 먼저 채워 주세요: ${form.missing.map((m) => m.label).join(', ')}`, 422, { missing: form.missing.map((m) => m.key) });
  if (def.inputs.some((i) => i.type === 'file-set' && i.required)) {
    const ready = (await ctx.store.listSources(task.id, task.organization_id)).filter((s) => s.status === 'ready');
    if (!ready.length) throw new WorkError('REQUIRED_INPUT_MISSING', '읽힌 원자료가 없습니다. 원자료를 먼저 올려 주세요.', 422);
  }
  // 취합의 직원 결정(중복 포함·제외·단위·잠정 승인)은 실행 내용에 실어 실행기가 다시 검사한다
  const decisions = input.decisions !== undefined && input.decisions !== null && typeof input.decisions === 'object' ? input.decisions : undefined;
  const payload = { operation: 'generate', baseVersion: cur.number, form: task.form, template: task.template_version_id, revision: task.revision, ...(decisions ? { decisions } : {}) };
  const { run, created } = await ctx.store.enqueueRun({
    taskId: task.id,
    organizationId: task.organization_id,
    operation: 'generate',
    idempotencyKey: key,
    payload,
    payloadHash: hashPayload(payload),
    baseVersion: cur.number,
    inputVersionId: cur.id,
    requestedBy: actor.userId,
  });
  if (created) await ctx.store.insertEvent({ organizationId: task.organization_id, taskId: task.id, actorId: actor.userId, type: 'run.generate.requested', details: { run_id: run.id } });
  return { run: runDto(run), created };
}

async function enqueuePackage(ctx: WorkContext, task: WorkTaskRow, versionId: string, userId: string) {
  const payload = { operation: 'package', versionId };
  const { run } = await ctx.store.enqueueRun({
    taskId: task.id,
    organizationId: task.organization_id,
    operation: 'package',
    idempotencyKey: `pkg-${versionId}`,
    payload,
    payloadHash: hashPayload(payload),
    baseVersion: 0,
    inputVersionId: versionId,
    requestedBy: userId,
  });
  return run;
}

/** 직접 수정 — 기준 판이 지금 판이어야 한다(아니면 409·최신 판 번호). 새 판 → 파일 만들기 실행 */
export async function saveDocument(ctx: WorkContext, actor: WorkActor, taskId: string, input: { baseVersion: unknown; patches: unknown }) {
  const { task } = await loadTask(ctx, actor, taskId, 'edit');
  if (typeof input.baseVersion !== 'number') throw new WorkError('INVALID_INPUT', 'baseVersion이 필요합니다.');
  const patches = parsePatches(input.patches);
  const cur = await currentVersionNumber(ctx, task);
  if (!cur.id) throw new WorkError('INVALID_INPUT', '아직 만든 문서가 없습니다. 먼저 파일을 만들어 주세요.', 409);
  if (input.baseVersion !== cur.number) throw new WorkError('VERSION_CONFLICT', '그 사이 문서가 바뀌었습니다. 최신 판을 불러온 뒤 다시 저장해 주세요.', 409, { currentVersion: cur.number });
  const applied = applyPatches(cur.fields, patches);
  if (!applied) return { version: null, run: null, unchanged: true };
  const v = await ctx.store.saveVersion({
    taskId: task.id,
    organizationId: task.organization_id,
    baseVersion: cur.number,
    fields: applied.fields,
    content: carriedContent(cur.content),
    templateVersionId: task.template_version_id,
    origin: 'edit',
    reason: `직접 수정: ${applied.fields.filter((f) => applied.changed.includes(f.id)).map((f) => f.label).join(', ')}`.slice(0, 500),
    actorId: actor.userId,
    runId: null,
    sourceIds: [],
  });
  await ctx.store.setTaskStatus(task.id, task.organization_id, 'needs_review');
  const run = await enqueuePackage(ctx, task, v.id, actor.userId);
  await ctx.store.insertEvent({ organizationId: task.organization_id, taskId: task.id, actorId: actor.userId, type: 'document.edited', details: { version: v.version, fields: applied.changed } });
  return { version: { id: v.id, version: v.version }, run: runDto(run), unchanged: false };
}

/** 복구 = 과거 내용으로 새 판(과거 판·파일은 그대로 — A09) */
export async function restoreVersion(ctx: WorkContext, actor: WorkActor, taskId: string, versionId: string, input: { baseVersion: unknown }) {
  const { task } = await loadTask(ctx, actor, taskId, 'edit');
  const old = await ctx.store.getVersion(versionId, task.organization_id);
  if (!old || old.task_id !== task.id) throw new WorkError('NOT_FOUND', '판을 찾을 수 없습니다.', 404);
  const cur = await currentVersionNumber(ctx, task);
  if (input.baseVersion !== cur.number) throw new WorkError('VERSION_CONFLICT', '그 사이 문서가 바뀌었습니다. 새로고침해 주세요.', 409, { currentVersion: cur.number });
  const fields = normalizeStoredFields(old.fields).map((f) => ({ ...f, origin: f.origin === 'empty' ? f.origin : ('restore' as const) }));
  const v = await ctx.store.saveVersion({
    taskId: task.id,
    organizationId: task.organization_id,
    baseVersion: cur.number,
    fields,
    templateVersionId: old.template_version_id,
    origin: 'restore',
    reason: `${old.version}판 내용으로 복구`,
    actorId: actor.userId,
    runId: null,
    sourceIds: old.source_ids,
    content: old.content,
  });
  await ctx.store.setTaskStatus(task.id, task.organization_id, 'needs_review');
  const run = await enqueuePackage(ctx, task, v.id, actor.userId);
  return { version: { id: v.id, version: v.version }, run: runDto(run) };
}

export async function listVersions(ctx: WorkContext, actor: WorkActor, taskId: string) {
  const { task } = await loadTask(ctx, actor, taskId);
  const [versions, artifacts] = await Promise.all([ctx.store.listVersions(task.id, task.organization_id), ctx.store.listArtifacts(task.id, task.organization_id)]);
  return versions.map((v) => ({
    id: v.id,
    version: v.version,
    origin: v.origin,
    changeReason: v.change_reason,
    createdBy: v.created_by,
    createdAt: v.created_at,
    current: v.id === task.current_document_version_id,
    artifacts: artifacts.filter((a) => a.document_version_id === v.id).map(artifactDto),
  }));
}

/** AI 수정 후보 요청 — 선택한 칸만(문서 전체 변경은 칸을 모두 고른 경우뿐) */
export async function requestRevision(ctx: WorkContext, actor: WorkActor, taskId: string, input: { baseVersion: unknown; fieldIds: unknown; instruction: unknown; idempotencyKey: unknown }) {
  await requireNewTasksEnabled(ctx, actor);
  const { task } = await loadTask(ctx, actor, taskId, 'edit');
  const key = cleanKey(input.idempotencyKey);
  const cur = await currentVersionNumber(ctx, task);
  if (!cur.id) throw new WorkError('INVALID_INPUT', '아직 만든 문서가 없습니다.', 409);
  if (input.baseVersion !== cur.number) throw new WorkError('VERSION_CONFLICT', '그 사이 문서가 바뀌었습니다. 새로고침해 주세요.', 409, { currentVersion: cur.number });
  const ids = Array.isArray(input.fieldIds) ? input.fieldIds.filter((x): x is string => typeof x === 'string') : [];
  if (!ids.length || ids.length > 20 || ids.some((id) => !cur.fields.some((f) => f.id === id))) throw new WorkError('INVALID_INPUT', '수정할 칸을 1~20개 골라 주세요.');
  if (ids.every((id) => cur.fields.find((f) => f.id === id)!.locked)) throw new WorkError('INVALID_INPUT', '고른 칸이 모두 잠겨 있습니다. 잠금을 풀거나 다른 칸을 고르세요.', 422);
  const instruction = typeof input.instruction === 'string' ? input.instruction.trim().slice(0, 1000) : '';
  if (!instruction) throw new WorkError('INVALID_INPUT', '어떻게 고칠지 적어 주세요.');
  const proposal = await ctx.store.insertProposal({ organization_id: task.organization_id, task_id: task.id, base_version: cur.number, field_ids: ids, instruction, created_by: actor.userId });
  const payload = { operation: 'revise', proposalId: proposal.id };
  const { run } = await ctx.store.enqueueRun({
    taskId: task.id,
    organizationId: task.organization_id,
    operation: 'revise',
    idempotencyKey: key,
    payload,
    payloadHash: hashPayload({ operation: 'revise', baseVersion: cur.number, ids, instruction }),
    baseVersion: cur.number,
    inputVersionId: cur.id,
    requestedBy: actor.userId,
  });
  await ctx.store.updateProposal(proposal.id, task.organization_id, { run_id: run.id });
  return { proposalId: proposal.id, run: runDto(run) };
}

export async function getProposal(ctx: WorkContext, actor: WorkActor, taskId: string, proposalId: string) {
  const { task } = await loadTask(ctx, actor, taskId);
  const p = await ctx.store.getProposal(proposalId, task.organization_id);
  if (!p || p.task_id !== task.id) throw new WorkError('NOT_FOUND', '수정 요청을 찾을 수 없습니다.', 404);
  const run = p.run_id ? await ctx.store.getRun(p.run_id, task.organization_id) : null;
  return { id: p.id, status: p.status, baseVersion: p.base_version, fieldIds: p.field_ids, instruction: p.instruction, changes: p.proposal ?? [], run: run ? runDto(run) : null };
}

/** 후보 적용 — 최신 판·권한·잠금을 다시 본 뒤 새 판 → 파일 */
export async function applyProposal(ctx: WorkContext, actor: WorkActor, taskId: string, proposalId: string, input: { baseVersion: unknown }) {
  const { task } = await loadTask(ctx, actor, taskId, 'edit');
  const p = await ctx.store.getProposal(proposalId, task.organization_id);
  if (!p || p.task_id !== task.id) throw new WorkError('NOT_FOUND', '수정 요청을 찾을 수 없습니다.', 404);
  if (p.status !== 'ready') throw new WorkError('INVALID_INPUT', p.status === 'applied' ? '이미 적용한 후보입니다.' : '아직 적용할 수 있는 후보가 없습니다.', 409);
  const cur = await currentVersionNumber(ctx, task);
  if (input.baseVersion !== cur.number || p.base_version !== cur.number) {
    await ctx.store.updateProposal(p.id, task.organization_id, { status: 'stale' }, 'ready');
    throw new WorkError('VERSION_CONFLICT', '후보를 만든 뒤 문서가 바뀌어 적용하지 않았습니다. 다시 요청해 주세요.', 409, { currentVersion: cur.number });
  }
  const changes = Object.fromEntries((p.proposal ?? []).map((c) => [c.fieldId, { value: c.after }]));
  const merged = mergeGenerated(cur.fields, changes, { origin: 'ai', onlyIds: p.field_ids });
  if (!merged.changed.length) throw new WorkError('INVALID_INPUT', '바뀔 내용이 없습니다(잠긴 칸이거나 같은 글).', 409);
  const v = await ctx.store.saveVersion({
    taskId: task.id,
    organizationId: task.organization_id,
    baseVersion: cur.number,
    fields: merged.fields,
    content: carriedContent(cur.content),
    templateVersionId: task.template_version_id,
    origin: 'revise',
    reason: `AI 수정 적용: ${p.instruction}`.slice(0, 500),
    actorId: actor.userId,
    runId: null,
    sourceIds: [],
  });
  const marked = await ctx.store.updateProposal(p.id, task.organization_id, { status: 'applied', applied_version_id: v.id }, 'ready');
  if (!marked) throw new WorkError('VERSION_CONFLICT', '다른 화면에서 이미 처리한 후보입니다.', 409);
  await ctx.store.setTaskStatus(task.id, task.organization_id, 'needs_review');
  const run = await enqueuePackage(ctx, task, v.id, actor.userId);
  await ctx.store.insertEvent({ organizationId: task.organization_id, taskId: task.id, actorId: actor.userId, type: 'document.revision_applied', details: { version: v.version, fields: merged.changed } });
  return { version: { id: v.id, version: v.version }, run: runDto(run) };
}

/** 확인 사항 처리·검토 완료. 검토 완료는 지금 판에 대해서만(오래된 승인은 409) */
export async function reviewTask(
  ctx: WorkContext,
  actor: WorkActor,
  taskId: string,
  input: { action: unknown; itemId?: unknown; note?: unknown; versionId?: unknown }
) {
  const { task, access } = await loadTask(ctx, actor, taskId, 'read');
  if (!task.current_document_version_id) throw new WorkError('INVALID_INPUT', '아직 만든 문서가 없습니다.', 409);
  if (input.action === 'resolve' || input.action === 'acknowledge') {
    if (!access.edit && !access.review) throw new WorkError('FORBIDDEN', '확인 사항을 처리할 권한이 없습니다.', 403);
    if (typeof input.itemId !== 'string') throw new WorkError('INVALID_INPUT', 'itemId가 필요합니다.');
    const items = await ctx.store.listReviewItems(task.current_document_version_id, task.organization_id);
    const item = items.find((i) => i.id === input.itemId);
    if (!item) throw new WorkError('NOT_FOUND', '확인 사항을 찾을 수 없습니다(판이 바뀌었을 수 있습니다).', 404);
    if (item.severity === 'blocking' && input.action === 'acknowledge') throw new WorkError('INVALID_INPUT', '반드시 고쳐야 하는 사항은 확인만으로 넘길 수 없습니다. 내용을 고친 뒤 다시 확인하세요.', 422);
    if (item.severity === 'blocking' && item.code === 'REQUIRED_EMPTY') {
      const cur = await currentVersionNumber(ctx, task);
      const f = cur.fields.find((x) => item.field_ids.includes(x.id));
      if (f && !f.value.trim()) throw new WorkError('INVALID_INPUT', `'${f.label}' 칸이 아직 비어 있습니다.`, 422);
    }
    const note = typeof input.note === 'string' ? input.note.trim().slice(0, 500) : null;
    await ctx.store.updateReviewItem(item.id, task.organization_id, task.current_document_version_id, {
      state: input.action === 'resolve' ? 'resolved' : 'acknowledged',
      resolved_by: actor.userId,
      resolution_note: note,
      resolved_at: ctx.now().toISOString(),
    });
    return { ok: true };
  }
  if (input.action === 'approve') {
    if (!access.review) throw new WorkError('FORBIDDEN', '검토를 마칠 권한이 없습니다.', 403);
    if (input.versionId !== task.current_document_version_id) throw new WorkError('VERSION_CONFLICT', '그 사이 새 판이 생겼습니다. 최신 판을 확인한 뒤 검토를 마쳐 주세요.', 409);
    const gate = await completionGate(ctx, task);
    if (gate.blocking > 0) throw new WorkError('INVALID_INPUT', `반드시 고쳐야 할 사항 ${gate.blocking}건이 남아 있습니다.`, 422);
    if (!gate.artifactReady) throw new WorkError('INVALID_INPUT', '이 판의 결과 파일이 아직 준비되지 않았습니다. 파일이 만들어진 뒤 검토를 마쳐 주세요.', 409);
    await ctx.store.setTaskStatus(task.id, task.organization_id, 'completed', { approved_version_id: task.current_document_version_id, approved_by: actor.userId, approved_at: ctx.now().toISOString() });
    await ctx.store.insertEvent({ organizationId: task.organization_id, taskId: task.id, actorId: actor.userId, type: 'task.approved', details: { version_id: task.current_document_version_id } });
    return { ok: true, status: 'completed' };
  }
  throw new WorkError('INVALID_INPUT', '알 수 없는 검토 동작입니다.');
}

/** 완료 조건(서버 판정) — 필요한 파일이 지금 판으로 있고 검증됐으며, 막는 사항이 없다 */
export async function completionGate(ctx: WorkContext, task: WorkTaskRow) {
  const versionId = task.current_document_version_id!;
  const impl = getWorkflowImpl(task.workflow_key);
  const [items, artifacts] = await Promise.all([ctx.store.listReviewItems(versionId, task.organization_id), ctx.store.listArtifacts(task.id, task.organization_id)]);
  const blocking = items.filter((i) => i.severity === 'blocking' && i.state === 'open').length;
  // 함께 만드는 파일이 여럿이면 모두 지금 판으로 있어야 한다(회의록 + 후속조치표 등)
  const keys = impl ? outputKeysOf(impl) : [];
  const artifactReady = keys.length > 0 && keys.every((k) => artifacts.some((a) => a.document_version_id === versionId && a.output_key === k && a.validation_status === 'valid'));
  return { blocking, artifactReady };
}

export async function cancelRun(ctx: WorkContext, actor: WorkActor, taskId: string, runId: string) {
  const { task } = await loadTask(ctx, actor, taskId, 'edit');
  const run = await ctx.store.getRun(runId, task.organization_id);
  if (!run || run.task_id !== task.id) throw new WorkError('NOT_FOUND', '실행을 찾을 수 없습니다.', 404);
  const updated = await ctx.store.requestCancel(run.id, task.organization_id);
  if (updated?.status === 'canceled' && task.current_run_id === run.id && task.status === 'processing') {
    await ctx.store.setTaskStatus(task.id, task.organization_id, task.current_document_version_id ? 'needs_review' : 'ready');
  }
  // 취소 '요청 접수'와 '실제 취소 완료'를 구분해 돌려준다
  return { run: runDto(updated ?? run), canceled: updated?.status === 'canceled', requested: Boolean(updated) };
}

export async function getRunForActor(ctx: WorkContext, actor: WorkActor, taskId: string, runId: string) {
  const { task } = await loadTask(ctx, actor, taskId);
  const run = await ctx.store.getRun(runId, task.organization_id);
  if (!run || run.task_id !== task.id) throw new WorkError('NOT_FOUND', '실행을 찾을 수 없습니다.', 404);
  return runDto(run);
}

/** 내려받기 — 지금 권한을 다시 보고 짧은 수명의 서명 주소. 주소는 기록에 남기지 않는다 */
export async function artifactDownloadUrl(ctx: WorkContext, actor: WorkActor, artifactId: string): Promise<string> {
  if (!/^[0-9a-f-]{36}$/i.test(artifactId)) throw new WorkError('NOT_FOUND', '파일을 찾을 수 없습니다.', 404);
  const a = await ctx.store.getArtifact(artifactId, actor.organizationId);
  if (!a) throw new WorkError('NOT_FOUND', '파일을 찾을 수 없습니다.', 404);
  const { task } = await loadTask(ctx, actor, a.task_id, 'download').catch(() => {
    throw new WorkError('NOT_FOUND', '파일을 찾을 수 없습니다.', 404);
  });
  if (a.validation_status !== 'valid') throw new WorkError('OUTPUT_INVALID', '검사를 통과하지 못한 파일은 내려받을 수 없습니다.', 409);
  const url = await ctx.files.signedDownloadUrl(a.storage_path, a.file_name, DOWNLOAD_URL_TTL_SECONDS);
  if (!url) throw new WorkError('STORAGE_FAILED', '내려받을 주소를 만들지 못했습니다. 잠시 뒤 다시 시도해 주세요.', 503);
  await ctx.store.insertEvent({ organizationId: task.organization_id, taskId: task.id, actorId: actor.userId, type: 'artifact.downloaded', details: { artifact_id: a.id } });
  return url;
}

/** 결과물 모음 — 내가 볼 수 있는 작업의 파일만 */
/** 다른 작업의 결과 파일을 이 작업의 원자료로 — 이 작업은 고칠 수 있어야 하고, 원래 작업은 내려받을 수 있어야 한다(같은 기관) */
export async function importArtifactAsSource(ctx: WorkContext, actor: WorkActor, taskId: string, input: { artifactId: unknown; purpose?: unknown }) {
  const { task } = await loadTask(ctx, actor, taskId, 'edit');
  if (typeof input.artifactId !== 'string' || !/^[0-9a-f-]{36}$/i.test(input.artifactId)) throw new WorkError('INVALID_INPUT', 'artifactId가 필요합니다.');
  const art = await ctx.store.getArtifact(input.artifactId, actor.organizationId);
  if (!art) throw new WorkError('NOT_FOUND', '결과 파일을 찾을 수 없습니다.', 404);
  if (art.task_id === task.id) throw new WorkError('INVALID_INPUT', '같은 작업의 결과 파일은 원자료로 가져올 수 없습니다.');
  // 원래 작업을 볼 수 없으면 404 — 남의 작업 파일이 있는지도 알려 주지 않는다
  await loadTask(ctx, actor, art.task_id, 'download');
  if (art.validation_status !== 'valid') throw new WorkError('INVALID_INPUT', '검사를 통과한 결과 파일만 가져올 수 있습니다.', 409);
  const purpose = (['reference', 'data', 'request', 'template', 'evidence'] as const).find((p) => p === input.purpose) ?? 'reference';
  const src = await copyArtifactToSource(ctx, task, actor.userId, art, purpose);
  if (src.status === 'ready') await refreshReadiness(ctx, task);
  await ctx.store.insertEvent({ organizationId: task.organization_id, taskId: task.id, actorId: actor.userId, type: 'source.imported', details: { source_id: src.id, from_task_id: art.task_id, artifact_id: art.id } });
  return sourceDto(src);
}

/** 대화에서 만든 파일·대화 첨부 중 본인 것 — 업무 원자료로 가져올 목록(이름·크기·때만) */
export async function listLegacyFiles(ctx: WorkContext, actor: WorkActor) {
  return ctx.store.listLegacyFiles(actor.userId, actor.organizationId);
}

/**
 * 대화에서 만든 파일(generated_files)·대화 첨부(chat_attachments)를 이 작업의 원자료로 — 본인 것·같은 기관만(06 문서 M4).
 * 바이트를 복사한다: 원래 대화를 지워도(연쇄 삭제·첨부 정리) 이 작업의 원자료는 남는다. 원본 참조는 origin에만
 */
export async function importLegacyFile(ctx: WorkContext, actor: WorkActor, taskId: string, input: { kind: unknown; id: unknown; purpose?: unknown }) {
  const { task } = await loadTask(ctx, actor, taskId, 'edit');
  if (input.kind !== 'generated' && input.kind !== 'attachment') throw new WorkError('INVALID_INPUT', 'kind는 generated 또는 attachment여야 합니다.');
  if (typeof input.id !== 'string' || !/^[0-9a-f-]{36}$/i.test(input.id)) throw new WorkError('INVALID_INPUT', 'id가 필요합니다.');
  const row = await ctx.store.getLegacyFile(input.kind, input.id, actor.userId, actor.organizationId);
  // 남의 것·다른 기관 것이면 있는지도 알리지 않는다
  if (!row) throw new WorkError('NOT_FOUND', '파일을 찾을 수 없습니다.', 404);
  const bytes = await ctx.files.get(row.storage_path);
  if (!bytes) throw new WorkError('NOT_FOUND', '원래 파일이 지워져 가져오지 못했습니다.', 404);
  const purpose = (['reference', 'data', 'request', 'template', 'evidence'] as const).find((p) => p === input.purpose) ?? 'reference';
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  const src = await copyBytesToSource(ctx, task, actor.userId, { fileName: row.file_name, bytes, mimeType: row.mime_type ?? 'application/octet-stream', purpose, origin: { type: input.kind === 'generated' ? 'chat_generated_file' : 'chat_attachment', id: input.id, sha256 } });
  if (src.status === 'ready') await refreshReadiness(ctx, task);
  await ctx.store.insertEvent({ organizationId: task.organization_id, taskId: task.id, actorId: actor.userId, type: 'source.imported_legacy', details: { source_id: src.id, kind: input.kind } });
  return sourceDto(src);
}

export async function listMyFiles(ctx: WorkContext, actor: WorkActor) {
  const { items } = await listTasks(ctx, actor, { limit: 50 });
  const out: (ReturnType<typeof artifactDto> & { taskTitle: string; current: boolean })[] = [];
  for (const t of items) {
    const arts = await ctx.store.listArtifacts(t.id, actor.organizationId);
    for (const a of arts) out.push({ ...artifactDto(a), taskTitle: t.title, current: a.document_version_id === t.currentDocumentVersionId });
  }
  return out.sort((x, y) => (x.created_at < y.created_at ? 1 : -1));
}
