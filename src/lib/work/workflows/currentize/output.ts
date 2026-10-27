// src/lib/work/workflows/currentize/output.ts
import { createHash } from 'crypto';
import { detectFormat, HWPX_MIME } from '@/lib/doc-fill';
import type { WorkContext } from '../../context';
import { WorkError, type WorkSourceRow, type WorkTaskRow } from '../../types';
import { checkPackage } from '../../documents/package-check';
import { applyChanges } from './apply';
import { readSegments, type Segment } from './segments';
import { buildChangeLogWorkbook } from './workbook';
import type { CurrentizeContent } from './plan';

/**
 * 현행화 판 → 파일. 실행기(runs/currentize-op.ts)와 파일 만들기(artifacts.ts)가 함께 쓴다.
 * 작년 파일은 원자료 원본 바이트 그대로이고, 쓰기 전에 언제나 해시를 다시 확인한다 — 다른 바이트에 변경(조각 id = 바이트 위치)을
 * 적용하면 엉뚱한 문단이 고쳐진다.
 */

/** 함께 만드는 변경 내역표의 결과 키(카탈로그 outputs 밖 — 현행화 판에만 생긴다) */
export const CHANGE_LOG_KEY = 'changeLog';
export const CHANGE_LOG_LABEL = '변경 내역';

const XLSX_MIME = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

export interface PriorFile {
  source: WorkSourceRow;
  bytes: Buffer;
  sha256: string;
}

/**
 * 작년 파일 원본 바이트. 해시가 원자료 기록(또는 판에 남긴 해시)과 다르면 PRIOR_MISMATCH,
 * HWPX가 아니면(HWP 5.0·DOCX) PRIOR_UNSUPPORTED — 조각 읽기·고치기가 HWPX만 한다(다시 시도해도 같다).
 */
export async function loadPriorFile(ctx: WorkContext, task: WorkTaskRow, sourceId: string, expectedSha256?: string): Promise<PriorFile> {
  const source = await ctx.store.getSource(sourceId, task.organization_id);
  if (!source || source.task_id !== task.id || source.purpose !== 'prior') throw new WorkError('PRIOR_MISMATCH', '작년 파일을 찾을 수 없습니다. 다시 올려 주세요.', 409);
  const bytes = await ctx.files.get(source.storage_path);
  if (!bytes) throw new WorkError('STORAGE_FAILED', '작년 파일을 불러오지 못했습니다. 잠시 뒤 다시 시도해 주세요.', 503);
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  if (sha256 !== source.sha256 || (expectedSha256 !== undefined && sha256 !== expectedSha256)) {
    throw new WorkError('PRIOR_MISMATCH', '작년 파일이 바뀌어 변경을 적용할 수 없습니다.', 409);
  }
  if (detectFormat(source.file_name, bytes) !== 'hwpx') {
    throw new WorkError('PRIOR_UNSUPPORTED', '작년 파일은 HWPX여야 합니다. 한글에서 HWPX로 저장해 다시 올려 주세요.', 422);
  }
  return { source, bytes, sha256 };
}

/** 변경 내역표의 '위치' — 표 칸은 '표 N (행,열)', 그 밖은 제목 사슬, 사슬이 없으면 글 앞부분 */
export function segmentLabels(segments: Segment[]): Map<string, string> {
  const out = new Map<string, string>();
  for (const s of segments) {
    if (s.cell) out.set(s.id, `표 ${s.cell.table + 1} (${s.cell.row + 1},${s.cell.col + 1})`);
    else if (s.path.length) out.set(s.id, s.path.join(' › '));
    else out.set(s.id, s.text.length > 20 ? `${s.text.slice(0, 20)}…` : s.text);
  }
  return out;
}

export interface CurrentizeFile {
  bytes: Buffer;
  format: 'hwpx' | 'xlsx';
  mimeType: string;
  sha256: string;
  entries: number;
  uncompressedBytes: number;
}

async function checked(bytes: Buffer, format: 'hwpx' | 'xlsx', values: string[]): Promise<CurrentizeFile> {
  const check = await checkPackage(bytes, { format, values });
  if (!check.valid) throw new WorkError('OUTPUT_INVALID', `만든 파일이 검사를 통과하지 못했습니다: ${check.problems.slice(0, 3).join('; ')}`, 422, { problems: check.problems });
  return { bytes, format, mimeType: format === 'hwpx' ? HWPX_MIME : XLSX_MIME, sha256: createHash('sha256').update(bytes).digest('hex'), entries: check.entries, uncompressedBytes: check.uncompressedBytes };
}

/** 현행화한 HWPX — 작년 원본 바이트 + 판의 변경 목록(바꿈만 적용). 넣은 글이 파일에 있는지까지 본다 */
export async function buildCurrentizedDocument(ctx: WorkContext, task: WorkTaskRow, content: CurrentizeContent): Promise<CurrentizeFile> {
  const prior = await loadPriorFile(ctx, task, content.priorSourceId, content.priorSha256);
  const bytes = await applyChanges(prior.bytes, content.changes);
  const values = content.changes.filter((c) => c.status === 'changed' && c.after).map((c) => c.after as string);
  return checked(bytes, 'hwpx', values);
}

/** 변경 내역표(XLSX) — 판의 변경 목록·인용 대조 그대로 */
export async function buildChangeLogFile(ctx: WorkContext, task: WorkTaskRow, content: CurrentizeContent, warnings: string[]): Promise<CurrentizeFile> {
  const prior = await loadPriorFile(ctx, task, content.priorSourceId, content.priorSha256);
  const { segments } = await readSegments(prior.bytes);
  const bytes = await buildChangeLogWorkbook(content, { title: task.title, createdAt: ctx.now(), segmentLabels: segmentLabels(segments), warnings });
  return checked(bytes, 'xlsx', content.changes.slice(0, 3).map((c) => c.id));
}
