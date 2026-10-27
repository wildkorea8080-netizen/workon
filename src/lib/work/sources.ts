// src/lib/work/sources.ts
import { createHash, randomUUID } from 'crypto';
import { gzipSync, gunzipSync } from 'zlib';
import type { ExtractedTable } from '@/lib/attachments/types';
import { attachmentExtension, refusedFormatMessage, MAX_ATTACHMENT_BYTES, CONFIRM_WINDOW_MS, MAX_EXTRACT_CHARS } from '@/lib/attachments/limits';
import { readAttachment, AttachmentReadError, tableAsMarkdown } from '@/lib/attachments/reader';
import type { WorkContext } from './context';
import { WorkError, type WorkSourceRow, type WorkTaskRow } from './types';
import { sourceExtractPath, sourceStoragePath } from './files';
import type { ComposeSource } from './generation/compose';

/**
 * 작업 원자료 — 대화 첨부와 수명이 따로다(24시간 정리·대화 삭제가 건드리지 않는다).
 * 올리기는 대화 첨부와 같은 길: 서명 주소로 저장소에 직접 → 서버가 확인(크기·해시·읽기).
 * 읽기는 기존 첨부 읽기(readAttachment — 형식별·표·스캔 PDF는 NODA /parse)를 그대로 쓴다.
 */
export const MAX_SOURCES_PER_TASK = 30;
export const MAX_SOURCE_BYTES = MAX_ATTACHMENT_BYTES;
const PURPOSES: readonly WorkSourceRow['purpose'][] = ['reference', 'data', 'request', 'template', 'evidence'];

export function cleanSourceName(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const name = raw
    .normalize('NFC')
    .replace(/[\p{Cc}\p{Cf}[\]\\/:*?"<>|]/gu, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 200);
  return name || null;
}

export async function createSourceUpload(
  ctx: WorkContext,
  task: WorkTaskRow,
  userId: string,
  input: { fileName: unknown; size: unknown; purpose?: unknown }
): Promise<{ sourceId: string; path: string; token: string }> {
  const name = cleanSourceName(input.fileName);
  if (!name) throw new WorkError('INVALID_INPUT', '파일 이름이 올바르지 않습니다.');
  const refused = refusedFormatMessage(name);
  if (refused) throw new WorkError('INVALID_INPUT', refused);
  const ext = attachmentExtension(name);
  if (!ext) throw new WorkError('INVALID_INPUT', '엑셀·CSV·한글·워드·PDF·파워포인트·TXT 파일만 올릴 수 있습니다.');
  const size = Number(input.size);
  if (!Number.isFinite(size) || size <= 0) throw new WorkError('INVALID_INPUT', '파일 크기를 알 수 없습니다.');
  if (size > MAX_SOURCE_BYTES) throw new WorkError('INVALID_INPUT', `파일 하나는 ${Math.round(MAX_SOURCE_BYTES / 1024 / 1024)}MB까지 올릴 수 있습니다.`, 413);
  const purpose = (PURPOSES as readonly unknown[]).includes(input.purpose) ? (input.purpose as WorkSourceRow['purpose']) : 'reference';
  const existing = await ctx.store.listSources(task.id, task.organization_id);
  if (existing.filter((s) => s.status !== 'failed').length >= MAX_SOURCES_PER_TASK) {
    throw new WorkError('INVALID_INPUT', `한 작업에 원자료는 ${MAX_SOURCES_PER_TASK}개까지 올릴 수 있습니다.`, 429);
  }
  const sourceId = randomUUID();
  const path = sourceStoragePath(task.organization_id, task.id, sourceId, ext);
  await ctx.store.insertSource({
    id: sourceId,
    task_id: task.id,
    organization_id: task.organization_id,
    uploaded_by: userId,
    purpose,
    file_name: name,
    file_ext: ext,
    size_bytes: size,
    storage_path: path,
  });
  const signed = await ctx.files.signedUploadToken(path);
  if (!signed) {
    await ctx.store.updateSource(sourceId, task.organization_id, { status: 'failed', failure_reason: '업로드 주소를 만들지 못했습니다.' });
    throw new WorkError('STORAGE_FAILED', '업로드 주소를 만들지 못했습니다. 잠시 뒤 다시 시도해 주세요.', 503);
  }
  return { sourceId, path, token: signed.token };
}

/** 확인 — 실제 객체·크기·해시를 보고 읽는다. 읽지 못한 파일은 오류가 아니라 failed(이유)로 남긴다 */
export async function confirmSource(ctx: WorkContext, task: WorkTaskRow, sourceId: string): Promise<WorkSourceRow> {
  const src = await ctx.store.getSource(sourceId, task.organization_id);
  if (!src || src.task_id !== task.id) throw new WorkError('NOT_FOUND', '원자료를 찾을 수 없습니다.', 404);
  if (src.status !== 'pending') return src;
  if (ctx.now().getTime() - new Date(src.created_at).getTime() > CONFIRM_WINDOW_MS) {
    await ctx.files.remove([src.storage_path]).catch(() => undefined);
    await ctx.store.updateSource(src.id, task.organization_id, { status: 'failed', failure_reason: '올린 지 오래되어 확인하지 않았습니다. 다시 올려 주세요.' });
    throw new WorkError('INVALID_INPUT', '올린 지 오래되어 확인하지 않았습니다. 다시 올려 주세요.', 410);
  }
  const bytes = await ctx.files.get(src.storage_path);
  if (!bytes) throw new WorkError('STORAGE_FAILED', '올린 파일을 찾지 못했습니다. 다시 올려 주세요.', 409);
  if (bytes.length > MAX_SOURCE_BYTES) {
    await ctx.files.remove([src.storage_path]).catch(() => undefined);
    await ctx.store.updateSource(src.id, task.organization_id, { status: 'failed', failure_reason: '파일이 너무 큽니다.' });
    throw new WorkError('INVALID_INPUT', '파일이 너무 큽니다.', 413);
  }
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  let extract;
  try {
    extract = await readAttachment(bytes, src.file_name);
  } catch (e) {
    const reason = e instanceof AttachmentReadError ? e.message : '파일을 읽지 못했습니다.';
    await ctx.store.updateSource(src.id, task.organization_id, { status: 'failed', failure_reason: reason.slice(0, 300) });
    return (await ctx.store.getSource(src.id, task.organization_id))!;
  }
  const tableText = extract.tables.map((t) => tableAsMarkdown(t)).join('\n\n');
  const text = (extract.text || tableText).slice(0, MAX_EXTRACT_CHARS);
  const extractPath = sourceExtractPath(task.organization_id, task.id, src.id);
  try {
    // 표는 계산용으로 그대로 둔다(취합 업무가 칸·병합·단위 캡션을 쓴다). 크기를 줄이려고 gzip(첨부 읽은 내용과 같은 방식)
    const body = JSON.stringify({ kind: extract.kind, text, warnings: extract.warnings, tables: extract.tables });
    await ctx.files.put(extractPath, gzipSync(Buffer.from(body)), 'application/gzip');
  } catch {
    throw new WorkError('STORAGE_FAILED', '읽은 내용을 저장하지 못했습니다. 잠시 뒤 다시 시도해 주세요.', 503);
  }
  await ctx.store.updateSource(src.id, task.organization_id, {
    status: 'ready',
    sha256,
    size_bytes: bytes.length,
    extract_path: extractPath,
    summary: { kind: extract.kind, pages: extract.pages ?? null, tables: extract.tables.length, chars: text.length, truncated: text.length >= MAX_EXTRACT_CHARS, warnings: extract.warnings.slice(0, 5) },
    confirmed_at: ctx.now().toISOString(),
  });
  await ctx.store.insertEvent({ organizationId: task.organization_id, taskId: task.id, actorId: src.uploaded_by, type: 'source.ready', details: { source_id: src.id, ext: src.file_ext, bytes: bytes.length } });
  return (await ctx.store.getSource(src.id, task.organization_id))!;
}

export interface SourceExtract extends ComposeSource {
  sha256: string;
  purpose: WorkSourceRow['purpose'];
  tables: ExtractedTable[];
  warnings: string[];
  truncated: boolean;
}

/** 읽힌 원자료(글·표) — 지금 작업의 것만. gzip 머리(1f 8b)가 없으면 평문 JSON으로 읽는다 */
export async function loadSourceExtracts(ctx: WorkContext, task: WorkTaskRow): Promise<SourceExtract[]> {
  const list = await ctx.store.listSources(task.id, task.organization_id);
  const out: SourceExtract[] = [];
  for (const s of list) {
    if (s.status !== 'ready' || !s.extract_path || s.task_id !== task.id) continue;
    const raw = await ctx.files.get(s.extract_path);
    if (!raw) throw new WorkError('STORAGE_FAILED', '원자료를 불러오지 못했습니다. 잠시 뒤 다시 시도해 주세요.', 503);
    try {
      const buf = raw[0] === 0x1f && raw[1] === 0x8b ? gunzipSync(raw) : raw;
      const parsed = JSON.parse(buf.toString('utf8')) as { text?: string; tables?: ExtractedTable[]; warnings?: string[] };
      const summary = (s.summary ?? {}) as { truncated?: boolean };
      out.push({
        id: s.id,
        name: s.file_name,
        text: String(parsed.text ?? ''),
        sha256: s.sha256 ?? '',
        purpose: s.purpose,
        tables: Array.isArray(parsed.tables) ? parsed.tables : [],
        warnings: Array.isArray(parsed.warnings) ? parsed.warnings : [],
        truncated: Boolean(summary.truncated) || (parsed.tables ?? []).some((t) => Boolean(t.truncated)),
      });
    } catch {
      throw new WorkError('STORAGE_FAILED', '원자료 읽은 내용이 손상되었습니다. 다시 올려 주세요.', 409);
    }
  }
  return out;
}

/** 생성에 넣을 원자료 글 */
export async function loadSourceTexts(ctx: WorkContext, task: WorkTaskRow): Promise<ComposeSource[]> {
  return (await loadSourceExtracts(ctx, task)).map((s) => ({ id: s.id, name: s.name, text: s.text }));
}

export function sourceDto(s: WorkSourceRow) {
  const { storage_path: _p, extract_path: _e, ...rest } = s;
  return rest;
}
