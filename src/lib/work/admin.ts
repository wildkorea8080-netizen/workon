// src/lib/work/admin.ts
import { createHash, randomUUID } from 'crypto';
import type { WorkContext } from './context';
import { WorkError, type WorkActor } from './types';
import type { TemplateVersionRow } from './store/types';
import { readFillableTemplate, generateDocumentFile } from './documents/generate-file';
import { fieldsFromSlots } from './documents/fields';
import { DOCUMENT_SUPPORT, templateLabel } from './documents/templates';
import { WORKFLOWS, CATALOG_VERSION } from './catalog';
import { getWorkflowImpl } from './workflows';
import type { WorkflowKey } from './types';

/**
 * 기관 관리자 — 기관 양식 등록·시험 생성·확인 기록·사용 중지, 업무 비서 켜고 끄기, 업무 현황(숫자만).
 *
 *  - 관리자도 직원 작업의 원문·파일은 열지 않는다(현황은 건수·실패 코드만 — 03 문서 '관리자 확장')
 *  - 시험 생성은 자리마다 시험 글을 넣어 만든 파일의 **패키지 검사**다. 한글 검증이라 적지 않는다
 *  - '한글에서 확인함'은 관리자가 직접 연 기록(누가·언제·메모)일 뿐 자동 검증이 아니다 — 그렇게 표시한다
 */
export const MAX_TEMPLATE_BYTES = 4 * 1024 * 1024;

export function requireWorkAdmin(actor: WorkActor) {
  if (!actor.isAdmin) throw new WorkError('FORBIDDEN', '기관 관리자만 할 수 있습니다.', 403);
}

function templatePath(orgId: string, id: string, ext: string) {
  return `work/${orgId}/templates/${id}.${ext}`;
}

/** 양식 칸 이름이 업무가 꼭 쓰는 칸을 갖췄는지 — 갖추지 않으면 그 업무에서 고를 때 빈 칸이 남는다 */
export function workflowFit(tv: Pick<TemplateVersionRow, 'manifest'>): { key: string; name: string; missing: string[] }[] {
  const labels = new Set(((tv.manifest as { slots?: { label: string }[] }).slots ?? []).map((s) => s.label));
  return WORKFLOWS.filter((w) => w.inputs.some((i) => i.type === 'template'))
    .map((w) => ({ w, impl: getWorkflowImpl(w.key) }))
    .filter((x) => x.impl && x.impl.kind !== 'collection' && x.impl.kind !== 'settlement')
    .map(({ w, impl }) => ({ key: w.key, name: w.name, missing: impl!.requiredFieldLabels.filter((l) => !labels.has(l)) }));
}

export function adminTemplateDto(tv: TemplateVersionRow) {
  const slots = ((tv.manifest as { slots?: { id: string; label: string; kind: string }[] }).slots ?? []).map((s) => ({ label: s.label, kind: s.kind }));
  return {
    id: tv.id,
    name: tv.name,
    fileName: tv.file_name,
    format: tv.format,
    source: tv.source,
    status: tv.status,
    label: templateLabel(tv),
    slots,
    verification: tv.verification,
    createdAt: tv.created_at,
    fit: workflowFit(tv),
  };
}

/**
 * 기관 양식 등록 — HWPX(표시·자동 자리)·DOCX(표시)만. 채울 자리를 못 찾는 양식은 받지 않는다(대체 경로로 다른 서식을 만들지 않게).
 * 같은 파일(sha256)을 다시 올리면 있던 판을 돌려준다. 올린 뒤 바로 시험 생성까지 한다
 */
export async function registerOrgTemplate(
  ctx: WorkContext,
  actor: WorkActor,
  input: { name: unknown; fileName: string; bytes: Buffer; agentTemplateId?: string | null }
) {
  requireWorkAdmin(actor);
  const name = typeof input.name === 'string' ? input.name.replace(/\s+/g, ' ').trim().slice(0, 120) : '';
  if (!name) throw new WorkError('INVALID_INPUT', '양식 이름을 적어 주세요.');
  const ext = /\.(hwpx|docx)$/i.exec(input.fileName)?.[1]?.toLowerCase();
  if (!ext) throw new WorkError('INVALID_INPUT', '기관 양식은 HWPX·DOCX만 등록할 수 있습니다(HWP는 한글에서 HWPX로 저장해 올려 주세요).');
  if (input.bytes.length > MAX_TEMPLATE_BYTES) throw new WorkError('INVALID_INPUT', '양식 파일은 4MB까지 올릴 수 있습니다.', 413);
  const read = await readFillableTemplate(input.bytes, input.fileName); // 자리를 못 찾으면 TEMPLATE_UNSUPPORTED(이유 포함)
  const sha256 = createHash('sha256').update(input.bytes).digest('hex');
  const existing = (await ctx.store.listOrgTemplatesAdmin(actor.organizationId)).find((t) => t.sha256 === sha256 && t.status !== 'retired');
  if (existing) return adminTemplateDto(existing);
  const id = randomUUID();
  const path = templatePath(actor.organizationId, id, ext);
  try {
    await ctx.files.put(path, input.bytes, ext === 'hwpx' ? 'application/hwp+zip' : 'application/vnd.openxmlformats-officedocument.wordprocessingml.document');
  } catch {
    throw new WorkError('STORAGE_FAILED', '양식 파일을 저장하지 못했습니다. 잠시 뒤 다시 시도해 주세요.', 503);
  }
  let tv: TemplateVersionRow;
  try {
    tv = await ctx.store.insertTemplateVersion({
      organization_id: actor.organizationId,
      source: input.agentTemplateId ? 'agent_template' : 'upload',
      builtin_ref: null,
      agent_template_id: input.agentTemplateId ?? null,
      storage_path: path,
      name,
      file_name: input.fileName.slice(0, 200),
      format: read.format,
      sha256,
      version: 1,
      status: 'draft',
      manifest: { slots: read.slots.map((s) => ({ id: s.id, label: s.label, kind: s.kind, hint: s.hint })) },
      supported: { ...DOCUMENT_SUPPORT },
      verification: null,
      created_by: actor.userId,
    } as Omit<TemplateVersionRow, 'id' | 'created_at'>);
  } catch (e) {
    await ctx.files.remove([path]).catch(() => undefined);
    throw e;
  }
  await ctx.store.insertEvent({ organizationId: actor.organizationId, taskId: null, actorId: actor.userId, type: 'template.registered', details: { template_id: tv.id, format: tv.format, slots: read.slots.length } });
  return testOrgTemplate(ctx, actor, tv.id);
}

/** 시험 생성 — 자리마다 시험 글을 넣어 실제 엔진으로 만들고 패키지 검사. 통과하면 '자동 검사 통과(한글 확인 전)'로 쓸 수 있다 */
export async function testOrgTemplate(ctx: WorkContext, actor: WorkActor, id: string) {
  requireWorkAdmin(actor);
  const tv = await ctx.store.getTemplateVersion(id, actor.organizationId);
  if (!tv || tv.organization_id !== actor.organizationId) throw new WorkError('NOT_FOUND', '양식을 찾을 수 없습니다.', 404);
  if (tv.status === 'retired') throw new WorkError('INVALID_INPUT', '사용 중지한 양식입니다.', 409);
  const bytes = tv.storage_path ? await ctx.files.get(tv.storage_path) : null;
  if (!bytes || createHash('sha256').update(bytes).digest('hex') !== tv.sha256) throw new WorkError('TEMPLATE_MISSING', '양식 파일을 불러오지 못했거나 등록한 파일과 다릅니다.', 409);
  const read = await readFillableTemplate(bytes, tv.file_name);
  const fields = fieldsFromSlots(read.slots).map((f) => ({ ...f, value: f.type === 'paragraph' ? `시험 글 — ${f.label}\n둘째 줄` : `시험 ${f.label}` }));
  const doc = await generateDocumentFile(bytes, tv.file_name, fields);
  if (!doc.check.valid) {
    await ctx.store.updateTemplateVersion(tv.id, actor.organizationId, { verification: { kind: 'package-test', result: 'failed', at: ctx.now().toISOString(), problems: doc.check.problems.slice(0, 5) } });
    throw new WorkError('OUTPUT_INVALID', `시험 생성 파일이 검사를 통과하지 못했습니다: ${doc.check.problems.slice(0, 3).join('; ')}`, 422);
  }
  const keepAttest = (tv.verification as { kind?: string } | null)?.kind === 'admin-attested' && tv.status === 'verified';
  const updated = await ctx.store.updateTemplateVersion(tv.id, actor.organizationId, keepAttest ? {} : {
    status: 'mapped',
    verification: { kind: 'package-test', result: 'passed', at: ctx.now().toISOString(), slots: read.slots.length, entries: doc.check.entries, by: actor.userId },
  });
  return adminTemplateDto(updated ?? tv);
}

/** 관리자가 한글에서 열어 본 기록 — 시험 생성을 통과한 양식만. 자동 검증이 아님을 기록에 남긴다 */
export async function attestOrgTemplate(ctx: WorkContext, actor: WorkActor, id: string, note: unknown) {
  requireWorkAdmin(actor);
  const tv = await ctx.store.getTemplateVersion(id, actor.organizationId);
  if (!tv || tv.organization_id !== actor.organizationId) throw new WorkError('NOT_FOUND', '양식을 찾을 수 없습니다.', 404);
  if (tv.status !== 'mapped') throw new WorkError('INVALID_INPUT', '시험 생성을 통과한 양식만 확인 기록을 남길 수 있습니다.', 409);
  const text = typeof note === 'string' ? note.trim().slice(0, 300) : '';
  if (text.length < 5) throw new WorkError('INVALID_INPUT', '무엇을 확인했는지 5자 이상 적어 주세요(예: 한글 2022에서 열어 쪽 배치 확인).');
  const prev = tv.verification ?? {};
  const updated = await ctx.store.updateTemplateVersion(tv.id, actor.organizationId, {
    status: 'verified',
    verification: { kind: 'admin-attested', by: actor.userId, at: ctx.now().toISOString(), note: text, packageTest: prev, automated: false },
  });
  await ctx.store.insertEvent({ organizationId: actor.organizationId, taskId: null, actorId: actor.userId, type: 'template.attested', details: { template_id: tv.id } });
  return adminTemplateDto(updated!);
}

/** 사용 중지 — 새 작업에서 고를 수 없게. 이미 이 판을 쓰는 작업은 그대로(판의 파일은 지우지 않음) */
export async function retireOrgTemplate(ctx: WorkContext, actor: WorkActor, id: string) {
  requireWorkAdmin(actor);
  const tv = await ctx.store.getTemplateVersion(id, actor.organizationId);
  if (!tv || tv.organization_id !== actor.organizationId) throw new WorkError('NOT_FOUND', '양식을 찾을 수 없습니다.', 404);
  const updated = await ctx.store.updateTemplateVersion(tv.id, actor.organizationId, { status: 'retired' });
  await ctx.store.insertEvent({ organizationId: actor.organizationId, taskId: null, actorId: actor.userId, type: 'template.retired', details: { template_id: tv.id } });
  return adminTemplateDto(updated!);
}

/** 대화 비서에 올려 둔 기관 양식(agent_templates)을 업무 양식으로 — 같은 기관의 것만, 바이트를 복사 */
export async function importAgentTemplate(ctx: WorkContext, actor: WorkActor, agentTemplateId: unknown) {
  requireWorkAdmin(actor);
  const list = await ctx.store.listOrgAgentTemplates(actor.organizationId);
  const t = list.find((x) => x.id === agentTemplateId);
  if (!t) throw new WorkError('NOT_FOUND', '기관 양식을 찾을 수 없습니다.', 404);
  const bytes = await ctx.files.get(t.storage_path);
  if (!bytes) throw new WorkError('STORAGE_FAILED', '원래 양식 파일을 찾지 못했습니다.', 409);
  return registerOrgTemplate(ctx, actor, { name: t.name, fileName: t.file_name, bytes, agentTemplateId: t.id });
}

export async function listAdminTemplates(ctx: WorkContext, actor: WorkActor) {
  requireWorkAdmin(actor);
  const [mine, chat] = await Promise.all([ctx.store.listOrgTemplatesAdmin(actor.organizationId), ctx.store.listOrgAgentTemplates(actor.organizationId)]);
  const imported = new Set(mine.map((t) => t.agent_template_id).filter(Boolean));
  return {
    templates: mine.map(adminTemplateDto),
    chatTemplates: chat.map((c) => ({ id: c.id, name: c.name, fileName: c.file_name, agentName: c.agent_name, imported: imported.has(c.id) })),
  };
}

// ── 업무 비서 켜고 끄기(기관 단위) ─────────────────────────────

export async function listInstallations(ctx: WorkContext, actor: WorkActor) {
  requireWorkAdmin(actor);
  const rows = await ctx.store.listInstallations(actor.organizationId);
  return WORKFLOWS.map((w) => {
    const r = rows.find((x) => x.workflow_key === w.key);
    const implemented = Boolean(getWorkflowImpl(w.key));
    return { key: w.key, name: w.name, implemented, status: !implemented ? 'preparing' : (r?.status ?? 'available'), updatedAt: r?.updated_at ?? null };
  });
}

export async function setInstallation(ctx: WorkContext, actor: WorkActor, key: unknown, enabled: unknown) {
  requireWorkAdmin(actor);
  const w = WORKFLOWS.find((x) => x.key === key);
  if (!w) throw new WorkError('INVALID_INPUT', '알 수 없는 업무입니다.');
  if (!getWorkflowImpl(w.key)) throw new WorkError('WORKFLOW_NOT_READY', '아직 준비 중인 업무입니다.', 409);
  await ctx.store.upsertInstallation(actor.organizationId, w.key, { status: enabled === true ? 'available' : 'disabled', workflowVersion: CATALOG_VERSION, installedBy: actor.userId });
  await ctx.store.insertEvent({ organizationId: actor.organizationId, taskId: null, actorId: actor.userId, type: enabled === true ? 'workflow.enabled' : 'workflow.disabled', details: { workflow_key: w.key } });
  return listInstallations(ctx, actor);
}

/** 이 기관에서 끈 업무 key — 새 작업을 막고 목록에서 '기관에서 쓰지 않음'으로 */
export async function disabledWorkflows(ctx: WorkContext, organizationId: string): Promise<Set<WorkflowKey>> {
  const rows = await ctx.store.listInstallations(organizationId);
  return new Set(rows.filter((r) => r.status === 'disabled').map((r) => r.workflow_key as WorkflowKey));
}

/** 업무 현황 — 업무별 작업 수·완료·검토 대기·최근 30일 실패 실행과 가장 많은 실패 코드(원문·파일 없음) */
export async function workOverview(ctx: WorkContext, actor: WorkActor) {
  requireWorkAdmin(actor);
  const since = new Date(ctx.now().getTime() - 30 * 86_400_000).toISOString();
  const rows = await ctx.store.workStats(actor.organizationId, since);
  const names = new Map(WORKFLOWS.map((w) => [w.key, w.name]));
  return rows.map((r) => ({ ...r, name: names.get(r.workflow_key as WorkflowKey) ?? r.workflow_key }));
}
