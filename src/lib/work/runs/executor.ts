// src/lib/work/runs/executor.ts
import { buildUsageDetails } from '@/lib/assistant/persist';
import type { WorkContext } from '../context';
import { WorkError, type DocumentField, type WorkRunRow, type WorkTaskRow, type WorkRunError } from '../types';
import { definitionFor, getWorkflowImpl, applyPrefill, outputKeysOf } from '../workflows';
import { checkForm, formFacts } from '../workflows/form';
import { fieldsFromSlots, mergeGenerated, normalizeStoredFields } from '../documents/fields';
import { loadTemplateBytes } from '../documents/templates';
import { readFillableTemplate } from '../documents/generate-file';
import { computeReviewItems } from '../review';
import { loadSourceTexts, loadSourceExtracts } from '../sources';
import { aggregateCollection, parseDecisions, type CollectionResult } from '../workflows/collection/aggregate';
import { buildArtifact } from '../artifacts';
import type { ComposeSource } from '../generation/compose';
import type { LlmUsage } from '@/lib/llm';
import type { NewReviewItem } from '../store/types';
import { gatherEvidence } from '../workflows/regulations/gather';
import { numberEvidence, isUsable, type RegulationEvidence } from '../workflows/regulations/evidence';
import { settleFindings, memoFieldValues, kstDate, type RegulationDraft, type RegulationOutcome } from '../workflows/regulations/memo';
import type { RegulationPlan } from '../workflows/regulations/model';
import { verifyItems, verifyMeta, type ExtractedItem, type VerifySource } from '../workflows/items/verify';
import { ITEMS_WORKFLOWS, departmentCandidates, flagReviewItems, type ItemsWorkflowKey } from '../workflows/items/specs';
import { reconcile, type SettlementResult } from '../workflows/settlement/reconcile';
import { factLines, qaReviewItems, verifyQa, type QaResult } from '../workflows/qa/verify';
import { auditFieldValues, replyFieldValues } from '../workflows/qa/output';

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
const RETRYABLE: ReadonlySet<string> = new Set(['LLM_UNAVAILABLE', 'STORAGE_FAILED', 'LLM_INVALID_OUTPUT', 'SOURCE_UNAVAILABLE']);

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
  const departmentName = await ctx.store.getDepartmentName(task.department_id, task.organization_id);
  fields = applyPrefill(fields, impl.prefill(form.values, { organizationName, departmentName, today: kstDate(ctx.now()) }));
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
      rules: def.validationRules,
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

/**
 * 취합 — 모델을 부르지 않는다. 원자료 표 → 표 엔진 → 부서·항목별 합(숫자는 프로그램이 냄) → 판(content.result) → 엑셀.
 * 직원 결정(중복 포함·제외·단위·잠정 승인)은 실행 내용(payload.decisions) → 없으면 지금 판의 결정 → 없으면 기본값.
 */
async function opGenerateCollection(ctx: WorkContext, run: WorkRunRow, task: WorkTaskRow, step: StepFn) {
  const def = definitionFor(task.workflow_key);
  const form = checkForm(def, task.form);
  if (form.missing.length) {
    throw new WorkError('REQUIRED_INPUT_MISSING', `필수 입력이 비어 있습니다: ${form.missing.map((m) => m.label).join(', ')}`, 422);
  }
  const computed = await step('aggregate', async () => {
    // 기준 양식(template)으로 올린 파일은 부서 제출이 아니다 — 합에 넣지 않는다
    const sources = (await loadSourceExtracts(ctx, task)).filter((x) => x.purpose !== 'template');
    if (!sources.length) throw new WorkError('REQUIRED_INPUT_MISSING', '읽힌 원자료가 없습니다.', 422);
    const expected = (form.values.expectedDepartments as string[]) ?? [];
    const fieldNames = ((form.values.fieldDefinitions as { name: string }[]) ?? []).map((f) => f.name);
    let previous: unknown = undefined;
    if (task.current_document_version_id) {
      const cur = await ctx.store.getVersion(task.current_document_version_id, task.organization_id);
      previous = (cur?.content as { result?: CollectionResult } | null)?.result?.decisions;
    }
    const decisions = parseDecisions(run.payload.decisions ?? previous, sources.map((x) => x.id), expected);
    const result = aggregateCollection({ sources, expectedDepartments: expected, fieldNames, decisions });
    return { result, sourceIds: sources.map((x) => x.id) } as unknown as Record<string, unknown>;
  });
  const result = computed.result as CollectionResult;
  const saved = await step('save_version', async () => {
    const existing = await ctx.store.getVersionByRun(task.id, run.id);
    if (existing) return { versionId: existing.id, version: existing.version };
    const v = await ctx.store.saveVersion({
      taskId: task.id,
      organizationId: task.organization_id,
      baseVersion: run.base_version,
      fields: [],
      content: { result },
      templateVersionId: null,
      origin: 'generate',
      reason: run.payload.decisions ? '직원 결정을 반영해 다시 취합' : '원자료 취합',
      actorId: run.requested_by,
      runId: run.id,
      sourceIds: computed.sourceIds as string[],
    });
    return { versionId: v.id, version: v.version };
  });
  await step('review', async () => {
    await ctx.store.replaceReviewItems(task.id, task.organization_id, saved.versionId, result.review.map((r) => ({ ...r, field_ids: [] })));
    return { count: result.review.length };
  });
  const file = await step('file', () => buildFileStep(ctx, run, task, saved.versionId));
  await ctx.store.setTaskStatus(task.id, task.organization_id, 'needs_review');
  return { versionId: saved.versionId, version: saved.version, artifactId: file.artifactId, provisional: result.provisional };
}

/** 규정 판(content.regulations)에 저장하는 것 — 그때 찾은 근거·판정·유보를 그대로 남긴다(감사: '무엇을 보고 썼나') */
export interface RegulationContent {
  schema: 'regulations/1';
  basisDate: string;
  plan: RegulationPlan;
  evidence: RegulationEvidence[];
  outcome: RegulationOutcome;
  unavailable: string[];
  review: NewReviewItem[];
  mode: 'llm' | 'mock';
}

async function writeModelUsage(ctx: WorkContext, run: WorkRunRow, task: WorkTaskRow, usage: LlmUsage | null, stage: string) {
  if (!usage) return;
  await ctx.store.writeUsage({
    departmentId: task.department_id,
    userId: run.requested_by,
    action: 'work_generate',
    resourceId: run.id,
    details: buildUsageDetails(usage, { task_id: task.id, run_id: run.id, attempt: run.attempt, workflow_key: task.workflow_key, agent_id: task.agent_id, stage }),
  });
}

/** 규정 판의 확인 사항 — 유보·제외 근거·시행일 미확인·쓸 수 없던 자료 범위 */
export function regulationReviewItems(c: Pick<RegulationContent, 'evidence' | 'outcome' | 'unavailable'>, fieldIdOf: (label: string) => string | null): NewReviewItem[] {
  const items: NewReviewItem[] = [];
  const opinion = fieldIdOf('검토 의견');
  const reservedField = fieldIdOf('유보·확인 필요');
  if (!c.outcome.findings.length) {
    items.push({ severity: 'warning', code: 'NO_SUPPORTED_FINDING', message: '확인한 근거로 받친 의견이 없어 판단을 유보했습니다. 근거를 더 올리거나 담당 부서에 확인하세요.', field_ids: opinion ? [opinion] : [] });
  }
  for (const r of c.outcome.reservations.slice(0, 10)) {
    items.push({ severity: 'warning', code: 'RESERVED', message: `유보: ${r.text.slice(0, 160)} — ${r.reason}`, field_ids: reservedField ? [reservedField] : [] });
  }
  if (c.outcome.findings.some((f) => f.dateCheck)) {
    items.push({ severity: 'warning', code: 'EFFECTIVE_DATE_UNKNOWN', message: '시행일을 확인하지 못한 근거로만 받친 의견이 있습니다. 적용 기준일에 그 판이 시행 중이었는지 확인하세요.', field_ids: opinion ? [opinion] : [] });
  }
  const excluded = c.evidence.filter((e) => !isUsable(e.applicability));
  if (excluded.length) {
    items.push({ severity: 'info', code: 'EVIDENCE_EXCLUDED', message: `근거 ${excluded.length}건을 뺐습니다(기준일 뒤 시행·다른 기관 자료): ${excluded.slice(0, 4).map((e) => e.id).join(', ')}`, field_ids: [] });
  }
  for (const u of c.unavailable) items.push({ severity: 'warning', code: 'SOURCE_LIMITED', message: `찾지 못한 자료 범위 — ${u}`, field_ids: [] });
  return items;
}

/**
 * 규정·지침 확인 — 찾을 말(모델) → 근거 모으기(기관 문서·공통 기준·법령·추가 자료, 프로그램) → 적용 판정(프로그램)
 * → 근거 번호를 단 의견 초안(모델) → 근거 없는 문장은 유보로(프로그램) → 메모 칸(위치·시행일은 프로그램) → 판·확인 사항·HWPX
 */
async function opGenerateRegulations(ctx: WorkContext, run: WorkRunRow, task: WorkTaskRow, step: StepFn) {
  if (!ctx.regulations) throw new WorkError('WORKFLOW_NOT_READY', '이 업무는 아직 준비 중입니다.', 409);
  const { providers, model: regModel } = ctx.regulations;
  const p = await step('prepare', () => prepareFields(ctx, task));
  const labels = new Set(p.fields.map((f) => f.label));
  if (!labels.has('검토 의견') || !labels.has('근거')) {
    throw new WorkError('TEMPLATE_UNSUPPORTED', "근거 검토 메모 양식에는 '검토 의견'·'근거' 칸이 있어야 합니다. 표준 근거 검토 메모 양식을 고르세요.", 422);
  }
  const def = definitionFor(task.workflow_key);
  const fact = (key: string) => p.facts.find((f) => f.label === def.inputs.find((i) => i.key === key)?.label)?.value ?? '';
  const question = fact('question');
  const basisDate = fact('basisDate');
  const scopeText = fact('scope');
  const organizationName = await ctx.store.getOrganizationName(task.organization_id);
  const planned = await step('plan', async () => {
    const model = await ctx.resolveModel(task.department_id);
    const r = await regModel.plan({ question, scope: scopeText, basisDate, organizationName }, { model });
    await writeModelUsage(ctx, run, task, r.usage, 'plan');
    return { plan: r.plan, mode: r.mode } as unknown as Record<string, unknown>;
  });
  const plan = planned.plan as RegulationPlan;
  const gathered = await step('gather', async () => {
    const g = await gatherEvidence(providers, { organizationId: task.organization_id, organizationName, departmentId: task.department_id }, plan, p.sources);
    return { evidence: numberEvidence(g.raw, { basisDate, organizationName }), unavailable: g.unavailable } as unknown as Record<string, unknown>;
  });
  const evidence = gathered.evidence as RegulationEvidence[];
  const unavailable = gathered.unavailable as string[];
  const drafted = await step('compose', async () => {
    const model = await ctx.resolveModel(task.department_id);
    const r = await regModel.review({ question, scope: scopeText, basisDate, organizationName, evidence }, { model });
    await writeModelUsage(ctx, run, task, r.usage, 'review');
    return { draft: r.draft, mode: r.mode } as unknown as Record<string, unknown>;
  });
  const outcome = settleFindings(drafted.draft as RegulationDraft, evidence);
  const mode = drafted.mode as 'llm' | 'mock';
  const saved = await step('save_version', async () => {
    const existing = await ctx.store.getVersionByRun(task.id, run.id);
    if (existing) return { versionId: existing.id, version: existing.version };
    const memo = memoFieldValues({
      title: task.title,
      question,
      basisDate,
      scope: scopeText,
      departmentName: await ctx.store.getDepartmentName(task.department_id, task.organization_id),
      today: kstDate(ctx.now()),
      evidence,
      outcome,
      unavailable,
    });
    const idOf = (label: string) => p.fields.find((f) => f.label === label)?.id ?? null;
    const systemValues: Record<string, { value: string }> = {};
    for (const [label, value] of Object.entries(memo.system)) {
      const id = idOf(label);
      if (id) systemValues[id] = { value };
    }
    let fields = mergeGenerated(p.fields, systemValues, { origin: 'system' }).fields;
    const opinionId = idOf('검토 의견')!;
    fields = mergeGenerated(fields, { [opinionId]: { value: memo.opinion, evidenceIds: [...new Set(outcome.findings.flatMap((f) => f.evidenceIds))] } }, { origin: 'ai' }).fields;
    const review = regulationReviewItems({ evidence, outcome, unavailable }, idOf);
    const content: RegulationContent = { schema: 'regulations/1', basisDate, plan, evidence, outcome, unavailable, review, mode };
    const v = await ctx.store.saveVersion({
      taskId: task.id,
      organizationId: task.organization_id,
      baseVersion: run.base_version,
      fields,
      content: { regulations: content },
      templateVersionId: p.templateVersionId,
      origin: 'generate',
      reason: mode === 'mock' ? '시험 모드로 근거 검토 메모 생성' : '근거 검토 메모 생성',
      actorId: run.requested_by,
      runId: run.id,
      sourceIds: p.sourceIds,
    });
    return { versionId: v.id, version: v.version };
  });
  const review = await step('review', async () => {
    const v = (await ctx.store.getVersion(saved.versionId, task.organization_id))!;
    const content = (v.content as { regulations?: RegulationContent } | null)?.regulations;
    const general = computeReviewItems({
      fields: normalizeStoredFields(v.fields),
      missing: [],
      knownText: [...p.facts.map((f) => f.value), ...evidence.map((e) => e.text)].join('\n'),
      testMode: mode === 'mock',
    });
    const items = [...general, ...(content?.review ?? [])];
    await ctx.store.replaceReviewItems(task.id, task.organization_id, v.id, items);
    return { blocking: items.filter((i) => i.severity === 'blocking').length, warning: items.filter((i) => i.severity === 'warning').length };
  });
  const file = await step('file', () => buildFileStep(ctx, run, task, saved.versionId));
  await ctx.store.setTaskStatus(task.id, task.organization_id, 'needs_review');
  return { versionId: saved.versionId, version: saved.version, artifactId: file.artifactId, review, mode, evidence: evidence.length, findings: outcome.findings.length };
}

/** 항목 판(content.items) — 그때 뽑은 항목·원문 인용·확인 표시를 그대로 남긴다 */
export interface ItemsContent {
  schema: 'items/1';
  name: string;
  typeLabel: string;
  columns: { key: string; label: string; type: string }[];
  items: ExtractedItem[];
  meta: Record<string, string>;
  summary: string;
  /** 처리표의 추가 열(담당 부서 후보 등) */
  extra: { label: string; values: Record<string, string> }[] | null;
  review: NewReviewItem[];
  mode: 'llm' | 'mock';
}

/**
 * 접수공문·회의·인수인계 — 원자료 → 항목 뽑기(모델, 원문 인용) → 원문 대조·날짜/사람 거르기(프로그램)
 * → (양식이 있으면) 칸 채우기(프로그램) → 업무별 확인 사항 → 처리표 XLSX·HWPX
 */
async function opGenerateItems(ctx: WorkContext, run: WorkRunRow, task: WorkTaskRow, step: StepFn) {
  if (!ctx.items) throw new WorkError('WORKFLOW_NOT_READY', '이 업무는 아직 준비 중입니다.', 409);
  const wf = ITEMS_WORKFLOWS[task.workflow_key as ItemsWorkflowKey];
  if (!wf) throw new WorkError('WORKFLOW_NOT_READY', '이 업무는 아직 준비 중입니다.', 409);
  const impl = getWorkflowImpl(task.workflow_key)!;
  const def = definitionFor(task.workflow_key);
  const form = checkForm(def, task.form);
  if (form.missing.length) {
    throw new WorkError('REQUIRED_INPUT_MISSING', `필수 입력이 비어 있습니다: ${form.missing.map((m) => m.label).join(', ')}`, 422);
  }
  const limit = await ctx.checkLimit(task.department_id, task.owner_id);
  if (!limit.allowed) throw new WorkError('USAGE_LIMIT', limit.message ?? '기관 사용 한도에 걸려 실행할 수 없습니다.', 429);
  const p = impl.defaultTemplateRef ? await step('prepare', () => prepareFields(ctx, task)) : null;

  const extracts = (await loadSourceExtracts(ctx, task)).filter((s) => s.purpose !== 'template');
  // 접수: '공문·붙임'(request)에서 뽑고 업무분장표(reference)는 부서 후보에만 쓴다. request가 없으면 올린 것 전부에서 뽑는다
  const requestSources = task.workflow_key === 'intake' && extracts.some((s) => s.purpose === 'request') ? extracts.filter((s) => s.purpose === 'request') : extracts;
  const mapSources = task.workflow_key === 'intake' && requestSources !== extracts ? extracts.filter((s) => s.purpose !== 'request') : [];
  const sources: VerifySource[] = requestSources.map((s) => ({ id: s.id, name: s.name, text: s.text }));
  // 인수인계: 직원이 직접 적은 '담당자 확인 현황'도 원자료다(다른 자료보다 우선 — 규칙에 적음)
  if (task.workflow_key === 'handover' && typeof form.values.confirmedStatus === 'string' && form.values.confirmedStatus.trim()) {
    sources.unshift({ id: 'confirmed', name: '담당자 확인 현황(직원 입력)', text: form.values.confirmedStatus });
  }
  if (!sources.length) throw new WorkError('REQUIRED_INPUT_MISSING', '읽힌 원자료가 없습니다. 원자료를 올려 주세요.', 422);

  const extracted = await step('compose', async () => {
    const model = await ctx.resolveModel(task.department_id);
    const r = await ctx.items!.model.extract({ workflowName: def.name, title: task.title, facts: formFacts(def, form.values), sources, spec: wf.spec }, { model });
    await writeModelUsage(ctx, run, task, r.usage, 'extract');
    return { items: r.items, meta: r.meta, summary: r.summary, mode: r.mode } as unknown as Record<string, unknown>;
  });
  const mode = extracted.mode as 'llm' | 'mock';
  const items = verifyItems(extracted.items as never, sources, wf.spec);
  const meta = verifyMeta((extracted.meta ?? {}) as Record<string, unknown>, sources, wf.spec);
  const candidates = mapSources.length ? departmentCandidates(items, mapSources.map((s) => s.text).join('\n')) : undefined;
  const summary = typeof extracted.summary === 'string' ? extracted.summary : '';
  const c = { form: form.values, items, meta: meta.values, summary, departmentCandidates: candidates };

  const saved = await step('save_version', async () => {
    const existing = await ctx.store.getVersionByRun(task.id, run.id);
    if (existing) return { versionId: existing.id, version: existing.version };
    let fields: DocumentField[] = p ? p.fields : [];
    if (p && wf.fieldValues) {
      const values = wf.fieldValues(c);
      const byLabel: Record<string, { value: string }> = {};
      for (const f of fields) if (values[f.label] !== undefined) byLabel[f.id] = { value: values[f.label] };
      fields = mergeGenerated(fields, byLabel, { origin: 'system' }).fields;
      // 요약(업무 개요 등)은 모델 글이다 — 출처를 'AI 초안'으로 바로잡는다
      if (summary) fields = fields.map((f) => (f.label === '업무 개요' && f.value === values['업무 개요'] ? { ...f, origin: 'ai' as const } : f));
    }
    const review = [...flagReviewItems(items), ...wf.checks(c), ...meta.notes.map((n) => ({ severity: 'info' as const, code: 'META_UNVERIFIED', message: n, field_ids: [] }))];
    const content: ItemsContent = {
      schema: 'items/1',
      name: wf.spec.name,
      typeLabel: wf.spec.typeColumn.label,
      columns: wf.spec.columns.map((x) => ({ key: x.key, label: x.label, type: x.type })),
      items,
      meta: meta.values,
      summary,
      extra: candidates ? [{ label: '담당 부서 후보(업무분장표)', values: Object.fromEntries(Object.entries(candidates).map(([k, v]) => [k, v.join(', ')])) }] : null,
      review,
      mode,
    };
    const v = await ctx.store.saveVersion({
      taskId: task.id,
      organizationId: task.organization_id,
      baseVersion: run.base_version,
      fields,
      content: { items: content },
      templateVersionId: p?.templateVersionId ?? null,
      origin: 'generate',
      reason: mode === 'mock' ? `시험 모드로 ${wf.spec.name} 정리` : `${wf.spec.name} 정리`,
      actorId: run.requested_by,
      runId: run.id,
      sourceIds: requestSources.map((s) => s.id),
    });
    return { versionId: v.id, version: v.version };
  });
  const review = await step('review', async () => {
    const v = (await ctx.store.getVersion(saved.versionId, task.organization_id))!;
    const content = (v.content as { items?: ItemsContent } | null)?.items;
    const vf = normalizeStoredFields(v.fields);
    const general = vf.length
      ? computeReviewItems({
          fields: vf,
          missing: vf.filter((f) => impl.humanOnlyLabels.includes(f.label) && !f.value.trim()).map((f) => ({ fieldId: f.id, reason: '직원이 정하는 칸입니다(AI가 채우지 않음).' })),
          knownText: [...formFacts(def, form.values).map((f) => f.value), ...sources.map((s) => s.text)].join('\n'),
          testMode: mode === 'mock',
        })
      : computeReviewItems({ fields: [], missing: [], knownText: '', testMode: mode === 'mock' });
    const all = [...general, ...(content?.review ?? [])];
    await ctx.store.replaceReviewItems(task.id, task.organization_id, v.id, all);
    return { blocking: all.filter((i) => i.severity === 'blocking').length, warning: all.filter((i) => i.severity === 'warning').length };
  });
  const file = await step('file', () => buildFileStep(ctx, run, task, saved.versionId));
  await ctx.store.setTaskStatus(task.id, task.organization_id, 'needs_review');
  return { versionId: saved.versionId, version: saved.version, artifactId: file.artifactId, review, mode, items: items.length };
}

/**
 * 예산·정산 대사 — 모델을 부르지 않는다. 원자료 표·글 → 대사(프로그램) → 판(content.settlement) → 대사표 엑셀
 */
async function opGenerateSettlement(ctx: WorkContext, run: WorkRunRow, task: WorkTaskRow, step: StepFn) {
  const def = definitionFor(task.workflow_key);
  const form = checkForm(def, task.form);
  if (form.missing.length) {
    throw new WorkError('REQUIRED_INPUT_MISSING', `필수 입력이 비어 있습니다: ${form.missing.map((m) => m.label).join(', ')}`, 422);
  }
  const computed = await step('aggregate', async () => {
    const sources = await loadSourceExtracts(ctx, task);
    if (!sources.length) throw new WorkError('REQUIRED_INPUT_MISSING', '읽힌 원자료가 없습니다.', 422);
    const result = reconcile({ sources: sources.map((s) => ({ id: s.id, name: s.name, purpose: s.purpose, text: s.text, tables: s.tables, warnings: s.warnings })), period: String(form.values.period ?? '') });
    return { result, sourceIds: sources.map((s) => s.id) } as unknown as Record<string, unknown>;
  });
  const result = computed.result as SettlementResult;
  const saved = await step('save_version', async () => {
    const existing = await ctx.store.getVersionByRun(task.id, run.id);
    if (existing) return { versionId: existing.id, version: existing.version };
    const v = await ctx.store.saveVersion({
      taskId: task.id,
      organizationId: task.organization_id,
      baseVersion: run.base_version,
      fields: [],
      content: { settlement: result },
      templateVersionId: null,
      origin: 'generate',
      reason: '예산·집행·증빙 대사',
      actorId: run.requested_by,
      runId: run.id,
      sourceIds: computed.sourceIds as string[],
    });
    return { versionId: v.id, version: v.version };
  });
  await step('review', async () => {
    await ctx.store.replaceReviewItems(task.id, task.organization_id, saved.versionId, result.review.map((r) => ({ ...r, field_ids: [] })));
    return { count: result.review.length };
  });
  const file = await step('file', () => buildFileStep(ctx, run, task, saved.versionId));
  await ctx.store.setTaskStatus(task.id, task.organization_id, 'needs_review');
  return { versionId: saved.versionId, version: saved.version, artifactId: file.artifactId, transactions: result.transactions.length };
}

/** 질문별 답변 판(content.qa) */
export interface QaContent {
  schema: 'qa/1';
  result: QaResult;
  review: NewReviewItem[];
  mode: 'llm' | 'mock';
}

/**
 * 민원·문의 회신 / 감사·평가 요구자료 — 질문 나누기·답(모델, 근거 번호) → 검사(프로그램: 누락·근거 없음·약속·다른 사람 정보·
 * 연도 혼합·과거 수치 차이) → 양식 칸 → 판 → HWPX(+ 감사 증빙목록 XLSX)
 */
async function opGenerateQa(ctx: WorkContext, run: WorkRunRow, task: WorkTaskRow, step: StepFn) {
  if (!ctx.qa) throw new WorkError('WORKFLOW_NOT_READY', '이 업무는 아직 준비 중입니다.', 409);
  const impl = getWorkflowImpl(task.workflow_key)!;
  const def = definitionFor(task.workflow_key);
  const kind = task.workflow_key === 'reply' ? 'reply' : 'audit';
  const p = await step('prepare', () => prepareFields(ctx, task));
  const form = checkForm(def, task.form);
  const extracts = (await loadSourceExtracts(ctx, task)).map((s) => ({ id: s.id, name: s.name, text: s.text, purpose: s.purpose }));
  const inquiryText = typeof form.values.inquiry === 'string' ? form.values.inquiry : '';
  const questionSources = kind === 'reply' ? [{ id: 'inquiry', name: '문의 내용', text: inquiryText }] : extracts.filter((s) => s.purpose === 'request');
  const evidenceSources = kind === 'reply' ? extracts.filter((s) => s.purpose !== 'template') : extracts.filter((s) => s.purpose === 'evidence');
  const priorSources = kind === 'audit' ? extracts.filter((s) => s.purpose === 'reference') : [];
  const facts = factLines(typeof form.values.confirmedFacts === 'string' ? form.values.confirmedFacts : '');
  const definitions = Array.isArray(form.values.indicatorDefinitions) ? (form.values.indicatorDefinitions as { name: string }[]).map((d) => d.name).filter(Boolean) : [];
  if (!questionSources.length || !questionSources.some((s) => s.text.trim())) throw new WorkError('REQUIRED_INPUT_MISSING', kind === 'reply' ? '문의 내용이 비어 있습니다.' : '요구서를 올려 주세요.', 422);

  const answered = await step('compose', async () => {
    const model = await ctx.resolveModel(task.department_id);
    const r = await ctx.qa!.model.answer({ kind, title: task.title, questionSources, evidenceSources, priorSources, facts, definitions }, { model });
    await writeModelUsage(ctx, run, task, r.usage, 'answer');
    return { raw: r.raw, mode: r.mode } as unknown as Record<string, unknown>;
  });
  const mode = answered.mode as 'llm' | 'mock';
  const result = verifyQa(answered.raw as never, { kind, questionSources, evidenceSources, priorSources, facts, inquiryText, definitionsText: definitions.join('\n') });
  const saved = await step('save_version', async () => {
    const existing = await ctx.store.getVersionByRun(task.id, run.id);
    if (existing) return { versionId: existing.id, version: existing.version };
    const values =
      kind === 'reply'
        ? replyFieldValues(result, { title: task.title, recipient: String(form.values.recipient ?? ''), today: kstDate(ctx.now()), departmentName: await ctx.store.getDepartmentName(task.department_id, task.organization_id) })
        : auditFieldValues(result, { title: task.title, organizationName: await ctx.store.getOrganizationName(task.organization_id), definitions });
    const aiLabels = new Set(['답변', '요구 항목별 답변']);
    const byId = (labels: (l: string) => boolean) => Object.fromEntries(p.fields.filter((f) => values[f.label] !== undefined && labels(f.label)).map((f) => [f.id, { value: values[f.label] }]));
    let fields = mergeGenerated(p.fields, byId((l) => !aiLabels.has(l)), { origin: 'system' }).fields;
    fields = mergeGenerated(fields, byId((l) => aiLabels.has(l)), { origin: 'ai' }).fields;
    const content: QaContent = { schema: 'qa/1', result, review: qaReviewItems(result), mode };
    const v = await ctx.store.saveVersion({
      taskId: task.id,
      organizationId: task.organization_id,
      baseVersion: run.base_version,
      fields,
      content: { qa: content },
      templateVersionId: p.templateVersionId,
      origin: 'generate',
      reason: mode === 'mock' ? '시험 모드로 질문별 답변' : '질문별 답변',
      actorId: run.requested_by,
      runId: run.id,
      sourceIds: extracts.map((s) => s.id),
    });
    return { versionId: v.id, version: v.version };
  });
  const review = await step('review', async () => {
    const v = (await ctx.store.getVersion(saved.versionId, task.organization_id))!;
    const content = (v.content as { qa?: QaContent } | null)?.qa;
    const vf = normalizeStoredFields(v.fields);
    const general = computeReviewItems({
      fields: vf,
      missing: vf.filter((f) => impl.humanOnlyLabels.includes(f.label) && !f.value.trim()).map((f) => ({ fieldId: f.id, reason: '직원이 정하는 칸입니다(AI가 채우지 않음).' })),
      knownText: [inquiryText, ...facts.map((f) => f.text), ...evidenceSources.map((s) => s.text), ...questionSources.map((s) => s.text), ...definitions].join('\n'),
      testMode: mode === 'mock',
    });
    const all = [...general, ...(content?.review ?? [])];
    await ctx.store.replaceReviewItems(task.id, task.organization_id, v.id, all);
    return { blocking: all.filter((i) => i.severity === 'blocking').length, warning: all.filter((i) => i.severity === 'warning').length };
  });
  const file = await step('file', () => buildFileStep(ctx, run, task, saved.versionId));
  await ctx.store.setTaskStatus(task.id, task.organization_id, 'needs_review');
  return { versionId: saved.versionId, version: saved.version, artifactId: file.artifactId, review, mode, questions: result.pairs.length };
}

async function opGenerate(ctx: WorkContext, run: WorkRunRow, task: WorkTaskRow, step: StepFn) {
  const kind = getWorkflowImpl(task.workflow_key)?.kind;
  if (kind === 'settlement') return opGenerateSettlement(ctx, run, task, step);
  if (kind === 'qa') return opGenerateQa(ctx, run, task, step);
  if (kind === 'items') return opGenerateItems(ctx, run, task, step);
  if (kind === 'collection') return opGenerateCollection(ctx, run, task, step);
  if (kind === 'regulations') return opGenerateRegulations(ctx, run, task, step);
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
  // 주 결과를 먼저 — 함께 만드는 파일(후속조치표 등)도 같은 판으로. 같은 판·같은 키는 한 벌이라 다시 시도해도 겹치지 않는다
  const built = [];
  for (const key of outputKeysOf(impl)) built.push(await buildArtifact(ctx, task, versionId, key, run.id));
  return { artifactId: built[0].id, sha256: built[0].sha256, previewStatus: built[0].preview_status, artifactIds: built.map((a) => a.id) };
}

/** 직접 수정·복구·후보 적용으로 생긴 판의 파일 만들기 */
async function opPackage(ctx: WorkContext, run: WorkRunRow, task: WorkTaskRow, step: StepFn) {
  const versionId = typeof run.payload.versionId === 'string' ? run.payload.versionId : run.input_document_version_id;
  if (!versionId) throw new WorkError('INVALID_INPUT', '파일을 만들 판이 없습니다.');
  const v = await ctx.store.getVersion(versionId, task.organization_id);
  if (!v || v.task_id !== task.id) throw new WorkError('NOT_FOUND', '판을 찾을 수 없습니다.', 404);
  await step('review', async () => {
    const result = (v.content as { result?: CollectionResult } | null)?.result;
    const settled = (v.content as { settlement?: SettlementResult } | null)?.settlement;
    if (settled?.schema === 'settlement/1') {
      await ctx.store.replaceReviewItems(task.id, task.organization_id, v.id, settled.review.map((r) => ({ ...r, field_ids: [] })));
      return { count: settled.review.length };
    }
    if (result?.schema === 'collection/1') {
      // 취합 판(복구 등)은 그 판에 저장된 계산 결과의 확인 사항을 그대로 다시 건다
      await ctx.store.replaceReviewItems(task.id, task.organization_id, v.id, result.review.map((r) => ({ ...r, field_ids: [] })));
      return { count: result.review.length };
    }
    const items = computeReviewItems({ fields: normalizeStoredFields(v.fields), missing: [], knownText: '', testMode: false });
    // 규정 판은 그 판에 저장한 근거 판정(유보·제외·시행일 미확인)을 다시 건다 — 직원이 칸을 고쳐도 근거가 바뀐 것은 아니다
    const reg = (v.content as { regulations?: RegulationContent } | null)?.regulations;
    const itemsContent = (v.content as { items?: ItemsContent } | null)?.items;
    const qaContent = (v.content as { qa?: QaContent } | null)?.qa;
    // 직접 수정한 판은 AI 숫자 대조 대상이 아니다(직원 글) — 필수 칸·자리 표시만 다시 본다
    await ctx.store.replaceReviewItems(task.id, task.organization_id, v.id, [...items.filter((i) => i.code !== 'UNVERIFIED_NUMBER'), ...(reg?.review ?? []), ...(itemsContent?.review ?? []), ...(qaContent?.review ?? [])]);
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
  // 규정 메모를 고칠 때는 그 판이 찾은 근거를 원자료로 준다(근거 밖 내용을 새로 지어내지 않게)
  const reg = (current.content as { regulations?: RegulationContent } | null)?.regulations;
  if (reg) p.sources = [...p.sources, ...reg.evidence.filter((e) => isUsable(e.applicability)).map((e) => ({ id: e.id, name: `${e.title}${e.location ? ` ${e.location}` : ''}`, text: e.text }))];
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
