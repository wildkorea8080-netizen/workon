// src/lib/work/runs/executor.ts
import { buildUsageDetails } from '@/lib/assistant/persist';
import type { WorkContext } from '../context';
import { WorkError, type DocumentField, type WorkRunRow, type WorkTaskRow, type WorkRunError } from '../types';
import { definitionFor, getWorkflowImpl, applyPrefill } from '../workflows';
import { checkForm, formFacts } from '../workflows/form';
import { fieldsFromSlots, mergeGenerated, normalizeStoredFields } from '../documents/fields';
import { loadTemplateBytes } from '../documents/templates';
import { readFillableTemplate } from '../documents/generate-file';
import { computeReviewItems } from '../review';
import { loadSourceTexts } from '../sources';
import { buildArtifact } from '../artifacts';
import type { ComposeSource } from '../generation/compose';

/**
 * 실행 하나를 끝까지 처리한다 — 작업자(runs/worker.ts)가 lease를 잡은 실행만 넘긴다.
 *
 *  - 단계마다 체크포인트(work_run_steps)를 남긴다. 다시 시도하면 끝난 단계(모델 호출 포함)를 건너뛴다 —
 *    같은 응답을 두 번 과금하지 않는다. 실제로 두 번 불렀다면(체크포인트 전에 죽음) 두 번 기록된다(그게 사실이다)
 *  - 단계 사이에 lease를 늘린다(heartbeat). lease를 잃었으면 결과를 쓰지 않고 멈춘다 — 다른 작업자가 이어 받는다
 *  - 문서 판 저장은 기준 판·현재 실행 확인을 DB가 원자적으로 한다(늦게 끝난 옛 실행이 새 판을 덮지 않음)
 *  - 실패는 안전한 문구만 남긴다(원문·키·서명 주소 없음). 일시 장애(모델·저장소)는 다시 시도, 입력 문제는 바로 실패
 */
export const LEASE_SECONDS = 120;
const RETRYABLE: ReadonlySet<string> = new Set(['LLM_UNAVAILABLE', 'STORAGE_FAILED', 'LLM_INVALID_OUTPUT']);

class LeaseLost extends Error {}

export interface RunOutcome {
  runId: string;
  finish: string;
  error?: WorkRunError;
}

function toRunError(e: unknown): WorkRunError {
  if (e instanceof WorkError) return { code: e.code, safeMessage: e.message, retryable: RETRYABLE.has(e.code) };
  return { code: 'INTERNAL', safeMessage: '처리 중 오류가 났습니다. 다시 시도해 주세요.', retryable: true };
}

export async function processRun(ctx: WorkContext, run: WorkRunRow, workerId: string): Promise<RunOutcome> {
  const org = run.organization_id;
  const step = async <T extends Record<string, unknown>>(name: string, fn: () => Promise<T>): Promise<T> => {
    const done = await ctx.store.getStep(run.id, name);
    if (done?.status === 'succeeded' && done.output) return done.output as T;
    await ctx.store.saveStep(run.id, org, name, run.attempt, 'running', null);
    const out = await fn();
    await ctx.store.saveStep(run.id, org, name, run.attempt, 'succeeded', out);
    if (!(await ctx.store.heartbeat(run.id, workerId, LEASE_SECONDS))) throw new LeaseLost();
    return out;
  };

  try {
    const task = await ctx.store.getTask(run.task_id, org);
    if (!task) throw new WorkError('NOT_FOUND', '작업을 찾을 수 없습니다.', 404);
    const fresh = await ctx.store.getRun(run.id, org);
    if (fresh?.cancel_requested_at) throw new WorkError('CANCELED', '실행을 취소했습니다.', 409);

    let result: Record<string, unknown>;
    if (run.operation === 'generate') result = await opGenerate(ctx, run, task, step);
    else if (run.operation === 'package') result = await opPackage(ctx, run, task, step);
    else if (run.operation === 'revise') result = await opRevise(ctx, run, task, step);
    else throw new WorkError('INVALID_INPUT', `지원하지 않는 실행입니다: ${run.operation}`);

    const finish = await ctx.store.finishRun(run.id, workerId, 'succeeded', null, result, 0);
    if (finish === 'succeeded') {
      await ctx.store.insertEvent({ organizationId: org, taskId: task.id, actorId: run.requested_by, type: `run.${run.operation}.succeeded`, details: { run_id: run.id } });
    }
    return { runId: run.id, finish };
  } catch (e) {
    if (e instanceof LeaseLost) return { runId: run.id, finish: 'lost' };
    const err = toRunError(e);
    if (err.code === 'SUPERSEDED' || err.code === 'VERSION_CONFLICT') err.retryable = false;
    if (!(e instanceof WorkError)) {
      await ctx.log({ level: 'error', category: 'work', message: '업무 실행 중 예외', details: { run_id: run.id, operation: run.operation, error: e instanceof Error ? e.message.slice(0, 300) : String(e).slice(0, 300) } });
    }
    const delay = Math.min(300, 5 * 2 ** Math.max(0, run.attempt - 1));
    const finish = await ctx.store.finishRun(run.id, workerId, 'failed', err, null, delay);
    if (finish !== 'requeued' && finish !== 'lost') {
      // 끝난 실패 — 작업을 처리 중에서 되돌린다(입력·편집본은 그대로 남는다)
      const task = await ctx.store.getTask(run.task_id, org);
      if (task && task.current_run_id === run.id && task.status === 'processing') {
        await ctx.store.setTaskStatus(task.id, org, task.current_document_version_id ? 'needs_review' : 'ready');
      }
      if (run.operation === 'revise' && typeof run.payload.proposalId === 'string') {
        await ctx.store.updateProposal(run.payload.proposalId, org, { status: 'failed' }, 'pending');
      }
      await ctx.store.insertEvent({ organizationId: org, taskId: run.task_id, actorId: run.requested_by, type: `run.${run.operation}.failed`, details: { run_id: run.id, code: err.code } });
    }
    return { runId: run.id, finish, error: err };
  }
}

type StepFn = <T extends Record<string, unknown>>(name: string, fn: () => Promise<T>) => Promise<T>;

interface Prepared extends Record<string, unknown> {
  fields: DocumentField[];
  targetIds: string[];
  facts: { label: string; value: string }[];
  sources: ComposeSource[];
  templateVersionId: string;
  sourceIds: string[];
  departmentId: string;
}

async function prepareFields(ctx: WorkContext, task: WorkTaskRow): Promise<Prepared> {
  const impl = getWorkflowImpl(task.workflow_key);
  if (!impl) throw new WorkError('WORKFLOW_NOT_READY', '이 업무는 아직 준비 중입니다.', 409);
  const def = definitionFor(task.workflow_key);
  const form = checkForm(def, task.form);
  if (form.missing.length) {
    throw new WorkError('REQUIRED_INPUT_MISSING', `필수 입력이 비어 있습니다: ${form.missing.map((m) => m.label).join(', ')}`, 422, { missing: form.missing.map((m) => m.key) });
  }
  const limit = await ctx.checkLimit(task.department_id, task.owner_id);
  if (!limit.allowed) throw new WorkError('USAGE_LIMIT', limit.message ?? '기관 사용 한도에 걸려 실행할 수 없습니다.', 429);
  if (!task.template_version_id) throw new WorkError('TEMPLATE_MISSING', '양식을 고르지 않았습니다.', 422);
  const tv = await ctx.store.getTemplateVersion(task.template_version_id, task.organization_id);
  if (!tv) throw new WorkError('TEMPLATE_MISSING', '고른 양식을 찾을 수 없습니다.', 404);
  const bytes = await loadTemplateBytes(ctx.files, tv);
  const read = await readFillableTemplate(bytes, tv.file_name);

  let fields = fieldsFromSlots(read.slots, impl.requiredFieldLabels);
  if (task.current_document_version_id) {
    const cur = await ctx.store.getVersion(task.current_document_version_id, task.organization_id);
    // 같은 양식 판이면 지금 판의 칸(직원 수정·잠금)을 이어 받는다
    if (cur && cur.template_version_id === tv.id) fields = normalizeStoredFields(cur.fields);
  }
  const organizationName = await ctx.store.getOrganizationName(task.organization_id);
  fields = applyPrefill(fields, impl.prefill(form.values, { organizationName }));
  const sources = await loadSourceTexts(ctx, task);
  // AI가 채울 칸: 잠기지 않았고, 직원이 고치거나 폼에서 채우지 않았으며, 직원이 정할 칸이 아닌 것
  const targetIds = fields
    .filter((f) => !f.locked && f.origin !== 'user' && f.origin !== 'form' && !impl.humanOnlyLabels.includes(f.label))
    .map((f) => f.id);
  return {
    fields,
    targetIds,
    facts: formFacts(def, form.values),
    sources,
    templateVersionId: tv.id,
    sourceIds: sources.map((s) => s.id),
    departmentId: task.department_id,
  };
}

async function composeStep(ctx: WorkContext, run: WorkRunRow, task: WorkTaskRow, p: Prepared, instruction?: string, onlyIds?: string[]) {
  const def = definitionFor(task.workflow_key);
  const targetIds = onlyIds ?? p.targetIds;
  if (targetIds.length === 0) return { values: {}, missing: [], mode: ctx.generatorMode, model: null };
  const model = await ctx.resolveModel(task.department_id);
  const res = await ctx.generator.compose(
    {
      workflowName: def.name,
      workflowPurpose: def.purpose,
      title: task.title,
      facts: p.facts,
      fields: p.fields,
      targetIds,
      sources: p.sources,
      organizationName: await ctx.store.getOrganizationName(task.organization_id),
      instruction,
    },
    { model }
  );
  if (res.usage) {
    // 과금 규약 — 모델·토큰·기록 시점 원가. 작업·실행·시도까지 남겨 대조할 수 있게
    await ctx.store.writeUsage({
      departmentId: task.department_id,
      userId: run.requested_by,
      action: run.operation === 'revise' ? 'work_revise' : 'work_generate',
      resourceId: run.id,
      details: buildUsageDetails(res.usage, { task_id: task.id, run_id: run.id, attempt: run.attempt, workflow_key: task.workflow_key, agent_id: task.agent_id }),
    });
  }
  return { values: res.values, missing: res.missing, mode: res.mode, model: res.usage?.model ?? null };
}

async function opGenerate(ctx: WorkContext, run: WorkRunRow, task: WorkTaskRow, step: StepFn) {
  const p = await step('prepare', () => prepareFields(ctx, task));
  const composed = await step('compose', () => composeStep(ctx, run, task, p));
  const saved = await step('save_version', async () => {
    // 저장 뒤 체크포인트 전에 죽었으면 그 판을 다시 쓴다 — 같은 실행이 판을 두 번 만들지 않는다
    const existing = await ctx.store.getVersionByRun(task.id, run.id);
    if (existing) return { versionId: existing.id, version: existing.version };
    const merged = mergeGenerated(p.fields, composed.values as Record<string, { value: string; evidenceIds?: string[] }>, { origin: 'ai' });
    const v = await ctx.store.saveVersion({
      taskId: task.id,
      organizationId: task.organization_id,
      baseVersion: run.base_version,
      fields: merged.fields,
      templateVersionId: p.templateVersionId,
      origin: 'generate',
      reason: composed.mode === 'mock' ? '시험 모드로 초안 생성' : '초안 생성',
      actorId: run.requested_by,
      runId: run.id,
      sourceIds: p.sourceIds,
    });
    return { versionId: v.id, version: v.version };
  });
  const review = await step('review', async () => {
    const v = (await ctx.store.getVersion(saved.versionId, task.organization_id))!;
    const items = computeReviewItems({
      fields: normalizeStoredFields(v.fields),
      missing: [
        ...(composed.missing as { fieldId: string; reason: string }[]),
        // 직원이 정할 칸이 비었으면 알린다(AI가 채우지 않는다)
        ...normalizeStoredFields(v.fields)
          .filter((f) => getWorkflowImpl(task.workflow_key)!.humanOnlyLabels.includes(f.label) && !f.value.trim())
          .map((f) => ({ fieldId: f.id, reason: '직원이 정하는 칸입니다(AI가 채우지 않음). 해당이 없으면 비워 두세요.' })),
      ],
      knownText: [...p.facts.map((f) => f.value), ...p.sources.map((s) => s.text)].join('\n'),
      testMode: composed.mode === 'mock',
    });
    await ctx.store.replaceReviewItems(task.id, task.organization_id, v.id, items);
    return { blocking: items.filter((i) => i.severity === 'blocking').length, warning: items.filter((i) => i.severity === 'warning').length };
  });
  const file = await step('file', () => buildFileStep(ctx, run, task, saved.versionId));
  await ctx.store.setTaskStatus(task.id, task.organization_id, 'needs_review');
  return { versionId: saved.versionId, version: saved.version, artifactId: file.artifactId, review, mode: composed.mode };
}

async function buildFileStep(ctx: WorkContext, run: WorkRunRow, task: WorkTaskRow, versionId: string) {
  const impl = getWorkflowImpl(task.workflow_key)!;
  const art = await buildArtifact(ctx, task, versionId, impl.documentOutputKey, run.id);
  return { artifactId: art.id, sha256: art.sha256, previewStatus: art.preview_status };
}

/** 직접 수정·복구·후보 적용으로 생긴 판의 파일 만들기 */
async function opPackage(ctx: WorkContext, run: WorkRunRow, task: WorkTaskRow, step: StepFn) {
  const versionId = typeof run.payload.versionId === 'string' ? run.payload.versionId : run.input_document_version_id;
  if (!versionId) throw new WorkError('INVALID_INPUT', '파일을 만들 판이 없습니다.');
  const v = await ctx.store.getVersion(versionId, task.organization_id);
  if (!v || v.task_id !== task.id) throw new WorkError('NOT_FOUND', '판을 찾을 수 없습니다.', 404);
  await step('review', async () => {
    const items = computeReviewItems({ fields: normalizeStoredFields(v.fields), missing: [], knownText: '', testMode: false });
    // 직접 수정한 판은 AI 숫자 대조 대상이 아니다(직원 글) — 필수 칸·자리 표시만 다시 본다
    await ctx.store.replaceReviewItems(task.id, task.organization_id, v.id, items.filter((i) => i.code !== 'UNVERIFIED_NUMBER'));
    return { count: items.length };
  });
  const file = await step('file', () => buildFileStep(ctx, run, task, v.id));
  return { versionId: v.id, version: v.version, artifactId: file.artifactId };
}

/** AI 수정 후보 — 선택한 칸만, 잠긴 칸은 빼고. 판을 만들지 않는다(직원이 적용할 때 만든다) */
async function opRevise(ctx: WorkContext, run: WorkRunRow, task: WorkTaskRow, step: StepFn) {
  const proposalId = typeof run.payload.proposalId === 'string' ? run.payload.proposalId : null;
  const proposal = proposalId ? await ctx.store.getProposal(proposalId, task.organization_id) : null;
  if (!proposal || proposal.task_id !== task.id) throw new WorkError('NOT_FOUND', '수정 요청을 찾을 수 없습니다.', 404);
  const p = await step('prepare', () => prepareFields(ctx, task));
  const current = await ctx.store.getVersion(task.current_document_version_id ?? '', task.organization_id);
  if (!current || current.version !== proposal.base_version) {
    await ctx.store.updateProposal(proposal.id, task.organization_id, { status: 'stale' });
    throw new WorkError('VERSION_CONFLICT', '그 사이 문서가 바뀌어 수정 후보를 만들지 않았습니다. 다시 요청해 주세요.', 409);
  }
  const fields = normalizeStoredFields(current.fields);
  const targets = proposal.field_ids.filter((id) => fields.some((f) => f.id === id && !f.locked));
  if (!targets.length) throw new WorkError('INVALID_INPUT', '고른 칸이 모두 잠겨 있어 바꿀 수 없습니다.', 422);
  const composed = await step('compose', () => composeStep(ctx, run, task, { ...p, fields }, proposal.instruction, targets));
  const values = composed.values as Record<string, { value: string }>;
  const diff = targets
    .map((id) => ({ fieldId: id, before: fields.find((f) => f.id === id)!.value, after: values[id]?.value ?? '' }))
    .filter((d) => d.after && d.after !== d.before);
  await ctx.store.updateProposal(proposal.id, task.organization_id, { status: 'ready', proposal: diff, run_id: run.id });
  return { proposalId: proposal.id, changes: diff.length };
}
