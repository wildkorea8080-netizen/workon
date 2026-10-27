// src/lib/work/artifacts.ts
import { safeFileName } from '@/lib/generated-files';
import type { WorkContext } from './context';
import { WorkError, type WorkArtifactRow, type WorkTaskRow } from './types';
import { normalizeStoredFields } from './documents/fields';
import { loadTemplateBytes } from './documents/templates';
import { generateDocumentFile } from './documents/generate-file';
import { artifactStoragePath } from './files';
import { RENDERER_UNAVAILABLE_REASON } from './documents/renderer';
import { checkPackage } from './documents/package-check';
import { getWorkflowImpl } from './workflows';
import { getWorkflow } from './catalog';
import { buildCollectionWorkbook } from './workflows/collection/workbook';
import type { CollectionResult } from './workflows/collection/aggregate';
import { buildItemsWorkbook } from './workflows/items/workbook';
import { ITEMS_WORKFLOWS, type ItemsWorkflowKey } from './workflows/items/specs';
import type { ItemsContent } from './runs/executor';
import { createHash } from 'crypto';

const XLSX_MIME = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

/** 함께 만드는 파일의 이름 꼬리 — 카탈로그 outputs의 label(후속조치표 등) */
function outputLabel(workflowKey: string, outputKey: string): string {
  return getWorkflow(workflowKey)?.outputs.find((o) => o.key === outputKey)?.label ?? outputKey;
}

interface BuiltFile {
  bytes: Buffer;
  format: 'hwpx' | 'docx' | 'xlsx';
  mimeType: string;
  sha256: string;
  entries: number;
  uncompressedBytes: number;
}

/** 취합 판의 결과(content.result) → 엑셀. 숫자는 판에 저장된 계산 결과 그대로 */
async function buildCollectionFile(task: WorkTaskRow, content: Record<string, unknown> | null): Promise<BuiltFile> {
  const result = (content?.result ?? null) as CollectionResult | null;
  if (!result || result.schema !== 'collection/1') throw new WorkError('OUTPUT_INVALID', '이 판에는 취합 결과가 없습니다.', 422);
  const period = typeof task.form.period === 'string' ? task.form.period : null;
  const bytes = await buildCollectionWorkbook({ title: task.title, period, result, createdAt: new Date() });
  const check = await checkPackage(bytes, { format: 'xlsx', values: result.departments.map((d) => d.name) });
  if (!check.valid) throw new WorkError('OUTPUT_INVALID', `만든 엑셀이 검사를 통과하지 못했습니다: ${check.problems.slice(0, 3).join('; ')}`, 422);
  return { bytes, format: 'xlsx', mimeType: XLSX_MIME, sha256: createHash('sha256').update(bytes).digest('hex'), entries: check.entries, uncompressedBytes: check.uncompressedBytes };
}

/** 항목 판(content.items) → 처리표 엑셀. 그 업무의 처리표에 넣을 항목만(회의는 후속조치·미결·조건부, 인수인계는 진행·미결·반복) */
async function buildItemsFile(task: WorkTaskRow, content: Record<string, unknown> | null): Promise<BuiltFile> {
  const c = (content?.items ?? null) as ItemsContent | null;
  const wf = ITEMS_WORKFLOWS[task.workflow_key as ItemsWorkflowKey];
  if (!c || c.schema !== 'items/1' || !wf) throw new WorkError('OUTPUT_INVALID', '이 판에는 뽑은 항목이 없습니다.', 422);
  const ctxItems = { form: task.form, items: c.items, meta: c.meta, summary: c.summary };
  const items = wf.sheetItems(ctxItems);
  const bytes = await buildItemsWorkbook({ title: task.title, spec: wf.spec, items, extraColumns: c.extra ?? undefined, review: c.review, createdAt: new Date(), testMode: c.mode === 'mock' });
  const check = await checkPackage(bytes, { format: 'xlsx', values: items.slice(0, 5).map((i) => i.id) });
  if (!check.valid) throw new WorkError('OUTPUT_INVALID', `만든 엑셀이 검사를 통과하지 못했습니다: ${check.problems.slice(0, 3).join('; ')}`, 422);
  return { bytes, format: 'xlsx', mimeType: XLSX_MIME, sha256: createHash('sha256').update(bytes).digest('hex'), entries: check.entries, uncompressedBytes: check.uncompressedBytes };
}

/**
 * 판 → 실제 결과 파일. 파일은 그 판에서 만든 불변 결과다(같은 판·같은 키는 한 벌).
 *
 * 순서: 원본 양식 + 판의 필드 → 파일 만들기 → 패키지 검사 → 저장소(같은 경로라 다시 시도해도 한 벌) → 기록 → 미리보기 상태.
 * 기록이 실패하면 올린 객체를 지운다(기록 없는 파일은 아무도 받거나 지울 수 없다).
 */
export async function buildArtifact(ctx: WorkContext, task: WorkTaskRow, versionId: string, outputKey: string, runId: string | null): Promise<WorkArtifactRow> {
  const existing = (await ctx.store.listArtifacts(task.id, task.organization_id)).find((a) => a.document_version_id === versionId && a.output_key === outputKey);
  if (existing) return existing;

  const v = await ctx.store.getVersion(versionId, task.organization_id);
  if (!v || v.task_id !== task.id) throw new WorkError('NOT_FOUND', '판을 찾을 수 없습니다.', 404);
  let gen: BuiltFile;
  const impl = getWorkflowImpl(task.workflow_key);
  const format = impl?.outputs?.find((o) => o.key === outputKey)?.format;
  if (impl?.kind === 'collection') {
    gen = await buildCollectionFile(task, v.content);
  } else if (impl?.kind === 'items' && format === 'xlsx') {
    gen = await buildItemsFile(task, v.content);
  } else {
    if (!v.template_version_id) throw new WorkError('TEMPLATE_MISSING', '이 판에는 양식이 없습니다.', 422);
    const tv = await ctx.store.getTemplateVersion(v.template_version_id, task.organization_id);
    if (!tv) throw new WorkError('TEMPLATE_MISSING', '양식을 찾을 수 없습니다.', 404);
    const bytes = await loadTemplateBytes(ctx.files, tv);
    const doc = await generateDocumentFile(bytes, tv.file_name, normalizeStoredFields(v.fields));
    gen = { bytes: doc.bytes, format: doc.format, mimeType: doc.mimeType, sha256: doc.sha256, entries: doc.check.entries, uncompressedBytes: doc.check.uncompressedBytes };
  }

  const path = artifactStoragePath(task.organization_id, task.id, v.id, outputKey, gen.format);
  try {
    await ctx.files.put(path, gen.bytes, gen.mimeType);
  } catch {
    throw new WorkError('STORAGE_FAILED', '파일을 저장하지 못했습니다. 잠시 뒤 다시 시도해 주세요.', 503);
  }
  let artifact: WorkArtifactRow;
  try {
    const r = await ctx.store.insertArtifact({
      organization_id: task.organization_id,
      task_id: task.id,
      document_version_id: v.id,
      run_id: runId,
      output_key: outputKey,
      format: gen.format,
      file_name: safeFileName(`${task.title}${outputKey === impl?.documentOutputKey ? '' : ` ${outputLabel(task.workflow_key, outputKey)}`} (${v.version}판)`, gen.format),
      mime_type: gen.mimeType,
      size_bytes: gen.bytes.length,
      sha256: gen.sha256,
      storage_path: path,
      validation_status: 'valid',
      validation: { kind: 'package', entries: gen.entries, uncompressedBytes: gen.uncompressedBytes, problems: [], hancomVisual: gen.format === 'hwpx' ? 'not_checked' : 'not_applicable' },
      preview_status: 'pending',
    });
    artifact = r.artifact;
  } catch (e) {
    await ctx.files.remove([path]).catch(() => undefined);
    throw e instanceof WorkError ? e : new WorkError('STORAGE_FAILED', '파일 기록을 남기지 못했습니다. 잠시 뒤 다시 시도해 주세요.', 503);
  }

  // 실제 파일 미리보기 — 렌더러가 없으면 없다고 남긴다(구조 미리보기로 대신하지 않는다)
  const health = await ctx.renderer.health();
  if (gen.format !== 'hwpx' || !health.available || !health.supportsHwpx) {
    const reason = gen.format === 'xlsx' ? '엑셀 파일은 화면의 표로 확인하고, 쪽 배치는 내려받아 엑셀에서 확인하세요.' : health.reason ?? RENDERER_UNAVAILABLE_REASON;
    await ctx.store.updateArtifact(artifact.id, task.organization_id, { preview_status: 'unsupported', preview: { reason } });
    artifact = { ...artifact, preview_status: 'unsupported' };
  } else {
    try {
      const r = await ctx.renderer.render({ bytes: gen.bytes, sha256: gen.sha256, format: 'hwpx' });
      const preview: Record<string, unknown> = { inputSha256: r.inputSha256, renderer: r.renderer, pageCount: r.pageCount, warnings: r.warnings };
      if (r.pdf) {
        const pdfPath = path.replace(/\.[a-z]+$/, '.preview.pdf');
        await ctx.files.put(pdfPath, r.pdf, 'application/pdf');
        preview.pdfPath = pdfPath;
      }
      await ctx.store.updateArtifact(artifact.id, task.organization_id, { preview_status: 'ready', preview });
      artifact = { ...artifact, preview_status: 'ready', preview };
    } catch (e) {
      await ctx.store.updateArtifact(artifact.id, task.organization_id, { preview_status: 'failed', preview: { reason: '실제 파일 미리보기를 만들지 못했습니다.' } });
      artifact = { ...artifact, preview_status: 'failed' };
      await ctx.log({ level: 'warning', category: 'work', message: '미리보기 실패', details: { artifact_id: artifact.id, error: e instanceof Error ? e.message.slice(0, 200) : 'unknown' } });
    }
  }
  await ctx.store.insertEvent({
    organizationId: task.organization_id,
    taskId: task.id,
    actorId: null,
    type: 'artifact.created',
    details: { artifact_id: artifact.id, version: v.version, format: gen.format, sha256: gen.sha256.slice(0, 16) },
  });
  return artifact;
}

/** 화면으로 나가는 꼴 — 저장 경로·미리보기 내부 경로를 뗀다 */
export function artifactDto(a: WorkArtifactRow) {
  const { storage_path: _p, preview, ...rest } = a;
  const pv = (preview ?? {}) as Record<string, unknown>;
  return {
    ...rest,
    preview: { pageCount: pv.pageCount ?? null, renderer: pv.renderer ?? null, reason: pv.reason ?? null, hasPdf: Boolean(pv.pdfPath) },
  };
}
