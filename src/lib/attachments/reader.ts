import type { AttachmentExtract, AttachmentSummary, Cell, ExtractedTable } from './types';
import {
  MAX_EXTRACT_CHARS,
  READ_TABLE_ROWS,
  attachmentExtension,
  refusedFormatMessage,
} from './limits';
import { buildTable } from './header';
import { readCsvTables, readXlsxTables } from './tables-sheet';
import { readHwpxTables, truncationWarnings } from './tables-hwpx';
import { isLikelyScanned } from '@/lib/pdf-ocr';

/**
 * 첨부 파일 바이트 → 본문 + 계산용 표 + 요약. 형식 판정은 전부 여기서 한다.
 * S4에서 다른 파싱 서비스로 바꿀 때 이 파일만 갈아 끼우면 되도록,
 * 호출하는 쪽(라우트·도구)은 형식을 모른다.
 */

const GENERIC_FAILURE = '파일을 읽지 못했습니다. 손상되었거나 암호가 걸린 파일일 수 있습니다.';

/** 메시지는 사람이 읽는 한국어 — 그대로 화면에 보여도 된다. */
export class AttachmentReadError extends Error {
  readonly cause?: unknown;

  constructor(message: string, cause?: unknown) {
    super(message);
    this.name = 'AttachmentReadError';
    // 서버 로그용 원인. 사용자에게는 message만 간다
    if (cause !== undefined) this.cause = cause;
  }
}

const n = (v: number) => v.toLocaleString('ko-KR');

// ── 표 → 마크다운 ────────────────────────────────────────────

function escapeCell(cell: Cell | undefined): string {
  if (cell == null) return '';
  return String(cell).replace(/\|/g, '\\|').replace(/\r?\n/g, ' ').trim();
}

/**
 * 머리글은 columns, 본문은 header.to + 1행부터. 병합 복사본이 없으므로 병합 칸은 주인 칸에만 값이 보인다.
 * offset/limit은 본문 행 기준(0부터) — 모델이 `offset`으로 이어 읽는다.
 */
export function tableAsMarkdown(
  table: ExtractedTable,
  opts: { offset?: number; limit?: number } = {}
): string {
  const body = table.cells.slice(table.header.to + 1);
  const offset = Math.max(0, Math.floor(opts.offset ?? 0));
  const limit = Math.max(1, Math.floor(opts.limit ?? READ_TABLE_ROWS));
  const page = body.slice(offset, offset + limit);
  const width = table.columns.length;

  const line = (cells: string[]) => `| ${cells.join(' | ')} |`;
  const out = [
    line(table.columns.map((c) => escapeCell(c))),
    line(table.columns.map(() => '---')),
    ...page.map((row) => line(Array.from({ length: width }, (_, c) => escapeCell(row[c])))),
  ];
  const rest = body.length - (offset + page.length);
  if (rest > 0) out.push(`… 이하 ${rest}행 더 있음 (offset=${offset + page.length}로 이어 읽기)`);
  return out.join('\n');
}

// ── 형식별 읽기 ──────────────────────────────────────────────

type Parsed = Omit<AttachmentExtract, 'warnings'> & { warnings?: string[] };

function spreadsheetText(tables: ExtractedTable[]): string {
  // 전체를 낸다(limit 무한) — 쪽 나눔은 모델이 표를 읽을 때만 쓴다
  return tables
    .map((t) => `## ${t.title}\n${tableAsMarkdown(t, { limit: Number.MAX_SAFE_INTEGER })}`)
    .join('\n\n');
}

async function readSpreadsheet(bytes: Buffer, ext: string): Promise<Parsed> {
  // 본문도 자기 표에서 만든다 — extractTextFromSpreadsheet는 시트당 500행에서 자른다
  if (ext === 'csv') {
    const { tables, warnings } = readCsvTables(bytes);
    return { kind: 'spreadsheet', text: spreadsheetText(tables), tables, warnings };
  }
  const { tables, sheets, warnings } = await readXlsxTables(bytes);
  return { kind: 'spreadsheet', text: spreadsheetText(tables), tables, sheets, warnings };
}

async function readHangul(bytes: Buffer, fileName: string, ext: string): Promise<Parsed> {
  const { extractTextFromHwp, extractHwpTables } = await import('@/lib/hwp');
  const text = await extractTextFromHwp(bytes, fileName);

  if (ext === 'hwpx') {
    const { tables, warnings } = await readHwpxTables(bytes);
    return { kind: 'document', text, tables, warnings };
  }

  const { grids, skippedSections } = extractHwpTables(bytes);
  const tables: ExtractedTable[] = [];
  const warnings: string[] = [];
  grids.forEach((g, i) => {
    const title = `표 ${i + 1}`;
    tables.push(buildTable(i + 1, title, g.cells, g.merges, g.caption, g.truncated));
    warnings.push(...truncationWarnings(title, g.truncated));
    if (g.droppedCells) warnings.push(`${title}: 표 범위 밖 칸 ${n(g.droppedCells)}개를 건너뛰었습니다`);
  });
  if (skippedSections.length > 0) {
    warnings.push(`본문 구역 ${n(skippedSections.length)}개를 읽지 못해 그 안의 표는 빠졌습니다`);
  }
  return { kind: 'document', text, tables, warnings };
}

async function readPdf(bytes: Buffer): Promise<Parsed> {
  // lib 파일을 직접 부른다 — 기본 import는 테스트 파일을 실행하다 던진다 (document-processor.ts와 같다)
  // @ts-ignore pdf-parse/lib 경로는 타입 선언이 없다
  const mod = await import('pdf-parse/lib/pdf-parse.js');
  const pdfParse = (mod as { default?: unknown }).default ?? mod;
  const data = await (pdfParse as (b: Buffer) => Promise<{ text?: string; numpages?: number }>)(bytes);
  const pages = data.numpages ?? 0;
  const text = data.text ?? '';
  // 글자 층이 없으면 pdf-parse는 오류가 아니라 빈 글을 준다. 판독(OCR)은 아직 첨부에 없다
  if (isLikelyScanned(text, pages)) {
    throw new AttachmentReadError('스캔 문서(글자 층이 없는 PDF)는 아직 읽지 못합니다.');
  }
  return { kind: 'document', text, tables: [], pages };
}

async function readDocx(bytes: Buffer): Promise<Parsed> {
  const mammoth = (await import('mammoth')).default;
  const result = await mammoth.extractRawText({ buffer: bytes });
  return { kind: 'document', text: result.value, tables: [] };
}

async function readPptx(bytes: Buffer): Promise<Parsed> {
  const { extractTextFromPptx } = await import('@/lib/pptx');
  return { kind: 'presentation', text: await extractTextFromPptx(bytes), tables: [] };
}

function readTxt(bytes: Buffer): Parsed {
  // 공공기관 텍스트는 EUC-KR이 흔하다. UTF-8로 읽어 깨지면 다시 시도한다 (spreadsheet.ts와 같은 판정)
  let text = new TextDecoder('utf-8').decode(bytes);
  if (text.includes('�')) {
    try {
      text = new TextDecoder('euc-kr').decode(bytes);
    } catch {
      // euc-kr 디코더가 없는 런타임이면 원래 결과를 쓴다
    }
  }
  return { kind: 'text', text: text.replace(/^﻿/, ''), tables: [] };
}

async function parse(bytes: Buffer, fileName: string, ext: string): Promise<Parsed> {
  switch (ext) {
    case 'xlsx':
    case 'xlsm':
    case 'csv':
      return readSpreadsheet(bytes, ext);
    case 'hwpx':
    case 'hwp':
      return readHangul(bytes, fileName, ext);
    case 'pdf':
      return readPdf(bytes);
    case 'docx':
      return readDocx(bytes);
    case 'pptx':
      return readPptx(bytes);
    default:
      return readTxt(bytes);
  }
}

/**
 * 실패는 항상 AttachmentReadError. 깨진 zip·암호 파일처럼 파서가 던지는 것은
 * 한 문장으로 감싸고 원인은 cause에 남긴다.
 */
export async function readAttachment(bytes: Buffer, fileName: string): Promise<AttachmentExtract> {
  const refused = refusedFormatMessage(fileName);
  if (refused) throw new AttachmentReadError(refused);
  const ext = attachmentExtension(fileName);
  if (!ext) throw new AttachmentReadError('읽을 수 없는 파일 형식입니다.');

  let parsed: Parsed;
  try {
    parsed = await parse(bytes, fileName, ext);
  } catch (err) {
    if (err instanceof AttachmentReadError) throw err;
    throw new AttachmentReadError(GENERIC_FAILURE, err);
  }

  const warnings = [...(parsed.warnings ?? [])];
  let text = parsed.text;
  if (text.length > MAX_EXTRACT_CHARS) {
    warnings.push(`본문이 ${n(text.length)}자라 앞의 ${n(MAX_EXTRACT_CHARS)}자만 읽었습니다`);
    text = text.slice(0, MAX_EXTRACT_CHARS);
  }
  if (!text.trim() && parsed.tables.length === 0) {
    throw new AttachmentReadError('파일에서 읽을 글이 없습니다.');
  }
  return { ...parsed, text, warnings };
}

/** 대화 기록에 남기는 요약. 본문은 싣지 않는다(모델이 도구로 읽는다). */
export function summarize(extract: AttachmentExtract): AttachmentSummary {
  return {
    kind: extract.kind,
    ...(extract.pages !== undefined ? { pages: extract.pages } : {}),
    ...(extract.sheets !== undefined ? { sheets: extract.sheets } : {}),
    chars: extract.text.length,
    tables: extract.tables.map((t) => ({
      id: t.id,
      title: t.title,
      rows: Math.max(0, t.cells.length - (t.header.to + 1)),
      columns: t.columns,
    })),
    warnings: extract.warnings,
  };
}
