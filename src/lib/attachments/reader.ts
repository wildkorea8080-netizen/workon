import type { AttachmentExtract, AttachmentSummary, Cell, ExtractedTable } from './types';
import {
  MAX_EXTRACT_CHARS,
  MAX_TABLES_PER_FILE,
  READ_TABLE_ROWS,
  attachmentExtension,
  refusedFormatMessage,
} from './limits';
import { buildTable, isNumericText } from './header';
import { readCsvTables, readXlsxTables } from './tables-sheet';
import { readHwpxTables, truncationWarnings } from './tables-hwpx';
import { SCAN_WARNING, isLikelyScanned, parsedToExtract } from './scan';
import { NodaError, noda } from '@/lib/noda';
import type { NodaParsedDocument } from '@/lib/noda';

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
 * 표 앞에 붙이는 줄 — 단위(caption)와 잘림. 개요·경고만으로는 모델이 표를 읽는 순간 단위를 잊거나
 * 경고 상한에 가려 일부만 읽은 표를 전체로 알고 합계를 낸다. 표를 볼 때마다 함께 보인다.
 */
function tablePreamble(table: ExtractedTable): string[] {
  const out: string[] = [];
  if (table.caption) out.push(`표 위 글: ${table.caption.replace(/\s+/g, ' ').trim()}`);
  const t = table.truncated;
  if (t && (t.rows || t.cols)) {
    const rows = t.rows ?? table.cells.length;
    const cols = t.cols ?? table.columns.length;
    out.push(`잘림: 원래 ${n(rows)}행 · ${n(cols)}열 중 일부만 읽음`);
  }
  return out;
}

/**
 * 보기 전용: 본문 안에서 시작한 세로 병합의 **글자** 칸을 아래 행에도 채운다 — 행 머리('총무과')가 비어 보이지 않게.
 * 숫자는 주인 칸에만 둔다(채우면 보고 더할 때 같은 값이 여러 번 더해진다). 저장된 칸(cells)은 바꾸지 않는다.
 * 머리글에서 내려온 병합은 채우지 않는다 — 열 이름이 데이터 칸에 찍힌다.
 * 보이는 행(fromRow 이상 toRow 미만, 표 전체 기준)만 계산한다 — 20,000행 병합을 쪽마다 다 풀지 않게.
 */
function verticalTextFill(table: ExtractedTable, fromRow: number, toRow: number): Map<number, Map<number, string>> {
  const fill = new Map<number, Map<number, string>>();
  for (const m of table.merges) {
    if (m.rows < 2 || m.row <= table.header.to) continue;
    const first = Math.max(m.row + 1, fromRow);
    const last = Math.min(m.row + m.rows, toRow);
    if (first >= last) continue;
    const owner = table.cells[m.row]?.[m.col];
    if (typeof owner !== 'string' || owner.trim() === '' || isNumericText(owner)) continue;
    for (let r = first; r < last; r += 1) {
      let row = fill.get(r);
      if (!row) fill.set(r, (row = new Map()));
      row.set(m.col, owner);
    }
  }
  return fill;
}

interface RenderedTable {
  lines: string[];
  offset: number;
  shown: number;
  /** 보이지 못한 본문 행 수 */
  rest: number;
}

/** 표 앞 줄 + 머리글 + 본문 행. maxChars를 넘기 전에 멈춘다(한 행은 넘더라도 낸다) */
function renderTable(
  table: ExtractedTable,
  opts: { offset?: number; limit?: number; maxChars?: number }
): RenderedTable {
  const bodyStart = table.header.to + 1;
  const bodyCount = Math.max(0, table.cells.length - bodyStart);
  const offset = Math.max(0, Math.floor(opts.offset ?? 0));
  const limit = Math.max(1, Math.floor(opts.limit ?? READ_TABLE_ROWS));
  const maxChars = opts.maxChars ?? Number.POSITIVE_INFINITY;
  const end = Math.min(bodyCount, offset + limit);
  const width = table.columns.length;
  const fill = verticalTextFill(table, bodyStart + offset, bodyStart + end);

  const line = (cells: string[]) => `| ${cells.join(' | ')} |`;
  const out = [
    ...tablePreamble(table),
    line(table.columns.map((c) => escapeCell(c))),
    line(table.columns.map(() => '---')),
  ];
  let size = out.reduce((sum, l) => sum + l.length + 1, 0);
  let shown = 0;
  for (let i = offset; i < end; i += 1) {
    const r = bodyStart + i;
    const row = table.cells[r] ?? [];
    const filled = fill.get(r);
    const l = line(Array.from({ length: width }, (_, c) => escapeCell(row[c] ?? filled?.get(c))));
    // 한 행은 넘더라도 낸다 — 아무 행도 못 내면 이어 읽기가 제자리에서 돈다
    if (shown > 0 && size + l.length + 1 > maxChars) break;
    out.push(l);
    size += l.length + 1;
    shown += 1;
  }
  return { lines: out, offset, shown, rest: Math.max(0, bodyCount - (offset + shown)) };
}

/**
 * 머리글은 columns, 본문은 header.to + 1행부터. 병합 복사본이 없으므로 병합 칸은 주인 칸에만 값이 보인다
 * (세로 병합된 글자 칸만 보기에서 아래로 채운다). 표 위 글(단위)·잘림이 있으면 표 앞에 적는다.
 * offset/limit은 본문 행 기준(0부터) — 모델이 `offset`으로 이어 읽는다.
 */
export function tableAsMarkdown(
  table: ExtractedTable,
  opts: { offset?: number; limit?: number; maxChars?: number } = {}
): string {
  const { lines, offset, shown, rest } = renderTable(table, opts);
  if (rest > 0) lines.push(`… 이하 ${rest}행 더 있음 (offset=${offset + shown}로 이어 읽기)`);
  return lines.join('\n');
}

// ── 형식별 읽기 ──────────────────────────────────────────────

/** textCut: 본문을 상한에서 멈춰 만들었다(전체 길이를 모른다) */
type Parsed = Omit<AttachmentExtract, 'warnings'> & { warnings?: string[]; textCut?: boolean; scanned?: boolean };

/** 스캔 PDF 읽기(NODA `/parse`). 테스트가 갈아 끼운다 */
export interface ReadDeps {
  parseScanned?: (bytes: Buffer, fileName: string) => Promise<NodaParsedDocument>;
}

const defaultParseScanned = (bytes: Buffer, fileName: string) => noda.parseDocument({ filename: fileName, bytes });

/** NODA가 준 이유 코드는 그대로 보이지 않는다 — 사람이 읽는 말로 */
function scanReasonLabel(reason: string | null | undefined): string {
  const r = (reason ?? '').toUpperCase();
  if (r.includes('PASSWORD')) return '암호가 걸린 파일';
  if (r.includes('DRM')) return '보안(DRM)이 걸린 파일';
  return '읽을 수 없는 파일';
}

/** 표가 너무 많으면 앞의 것만. 읽은 내용 크기와 개요를 파일이 정하게 두지 않는다. 경고는 맨 앞에 — 개요는 경고를 3개만 보인다 */
function capTables(tables: ExtractedTable[], warnings: string[]): ExtractedTable[] {
  if (tables.length <= MAX_TABLES_PER_FILE) return tables;
  warnings.unshift(`표가 많아 앞의 ${MAX_TABLES_PER_FILE}개만 읽었습니다 (전체 ${n(tables.length)}개)`);
  return tables.slice(0, MAX_TABLES_PER_FILE);
}

/**
 * 표들을 본문 글로(쪽 나눔 없이 — 쪽 나눔은 모델이 표를 읽을 때만 쓴다). 상한(MAX_EXTRACT_CHARS)에 닿으면
 * 거기서 멈춘다 — 20,000행 표 여러 장을 다 만든 뒤 자르면 함수 메모리·시간만 쓴다. 멈췄으면 cut.
 * 표 자체(계산용)는 그대로 남는다.
 */
function spreadsheetText(tables: ExtractedTable[]): { text: string; cut: boolean } {
  const parts: string[] = [];
  let used = 0;
  for (const t of tables) {
    const heading = `## ${t.title}\n`;
    const room = MAX_EXTRACT_CHARS - used - heading.length;
    if (room <= 0) return { text: parts.join('\n\n'), cut: true };
    const r = renderTable(t, { offset: 0, limit: Number.MAX_SAFE_INTEGER, maxChars: room });
    const chunk = heading + r.lines.join('\n');
    parts.push(chunk);
    used += chunk.length + 2;
    if (r.rest > 0) return { text: parts.join('\n\n'), cut: true };
  }
  return { text: parts.join('\n\n'), cut: false };
}

async function readSpreadsheet(bytes: Buffer, ext: string): Promise<Parsed> {
  // 본문도 자기 표에서 만든다 — extractTextFromSpreadsheet는 시트당 500행에서 자른다
  const read = ext === 'csv' ? { ...readCsvTables(bytes), sheets: undefined } : await readXlsxTables(bytes);
  const warnings = [...read.warnings];
  const tables = capTables(read.tables, warnings);
  const { text, cut } = spreadsheetText(tables);
  return {
    kind: 'spreadsheet',
    text,
    textCut: cut,
    tables,
    ...(read.sheets !== undefined ? { sheets: read.sheets } : {}),
    warnings,
  };
}

/** 확장자가 아니라 내용으로 가른다 — HWPX를 .hwp로 이름만 바꾼 파일이 있다(본문 읽기 extractTextFromHwp도 서명으로 가른다) */
function isZip(bytes: Buffer): boolean {
  return bytes.length >= 4 && bytes[0] === 0x50 && bytes[1] === 0x4b && bytes[2] === 0x03 && bytes[3] === 0x04;
}

async function readHangul(bytes: Buffer, fileName: string): Promise<Parsed> {
  const { extractTextFromHwp, extractHwpTables } = await import('@/lib/hwp');
  const text = await extractTextFromHwp(bytes, fileName);

  // zip(PK\x03\x04)이면 HWPX, 아니면 HWP 5.0(CFB D0 CF 11 E0) — HWP 5.0 표 읽기는 CFB가 아니면 던진다
  if (isZip(bytes)) {
    const read = await readHwpxTables(bytes);
    const warnings = [...read.warnings];
    return { kind: 'document', text, tables: capTables(read.tables, warnings), warnings };
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
  return { kind: 'document', text, tables: capTables(tables, warnings), warnings };
}

async function readPdf(bytes: Buffer, fileName: string, deps: ReadDeps): Promise<Parsed> {
  // lib 파일을 직접 부른다 — 기본 import는 테스트 파일을 실행하다 던진다
  // @ts-ignore pdf-parse/lib 경로는 타입 선언이 없다
  const mod = await import('pdf-parse/lib/pdf-parse.js');
  const pdfParse = (mod as { default?: unknown }).default ?? mod;
  const data = await (pdfParse as (b: Buffer) => Promise<{ text?: string; numpages?: number }>)(bytes);
  const pages = data.numpages ?? 0;
  const text = data.text ?? '';
  // 글자 층이 없으면 pdf-parse는 오류가 아니라 빈 글을 준다 — 그때만 NODA로 읽는다. 글자 층이 있으면 NODA를 부르지 않는다
  if (!isLikelyScanned(text, pages)) return { kind: 'document', text, tables: [], pages };
  return readScannedPdf(bytes, fileName, pages, deps);
}

async function readScannedPdf(bytes: Buffer, fileName: string, pdfPages: number, deps: ReadDeps): Promise<Parsed> {
  let doc: NodaParsedDocument;
  try {
    doc = await (deps.parseScanned ?? defaultParseScanned)(bytes, fileName);
  } catch (err) {
    if (err instanceof NodaError) {
      // 키가 없으면 지금까지처럼 '아직 못 읽는다' — 장애와 달리 다시 올려도 같다
      if (err.code === 'missing_key') {
        throw new AttachmentReadError('스캔 문서(글자 층이 없는 PDF)는 아직 읽지 못합니다.', err);
      }
      throw new AttachmentReadError('스캔 문서를 지금 읽지 못했습니다. 잠시 뒤 다시 올려 주세요.', err);
    }
    throw err;
  }
  if (!doc.readable) {
    throw new AttachmentReadError(`스캔 문서를 읽지 못했습니다(사유: ${scanReasonLabel(doc.reason)})`);
  }
  const read = parsedToExtract(doc);
  const warnings = [...read.warnings];
  const tables = capTables(read.tables, warnings);
  return {
    kind: 'document',
    text: read.text,
    tables,
    pages: read.pages > 0 ? read.pages : pdfPages,
    warnings,
    scanned: true,
  };
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
  // 공공기관 텍스트는 EUC-KR이 흔하다. UTF-8로 읽어 깨지면 다시 시도한다 (tables-sheet.ts의 CSV 읽기와 같은 판정)
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

async function parse(bytes: Buffer, fileName: string, ext: string, deps: ReadDeps): Promise<Parsed> {
  switch (ext) {
    case 'xlsx':
    case 'xlsm':
    case 'csv':
      return readSpreadsheet(bytes, ext);
    case 'hwpx':
    case 'hwp':
      return readHangul(bytes, fileName);
    case 'pdf':
      return readPdf(bytes, fileName, deps);
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
export async function readAttachment(bytes: Buffer, fileName: string, deps: ReadDeps = {}): Promise<AttachmentExtract> {
  const refused = refusedFormatMessage(fileName);
  if (refused) throw new AttachmentReadError(refused);
  const ext = attachmentExtension(fileName);
  if (!ext) throw new AttachmentReadError('읽을 수 없는 파일 형식입니다.');

  let parsed: Parsed;
  try {
    parsed = await parse(bytes, fileName, ext, deps);
  } catch (err) {
    if (err instanceof AttachmentReadError) throw err;
    throw new AttachmentReadError(GENERIC_FAILURE, err);
  }

  const { textCut, scanned, ...rest } = parsed;
  const warnings = [...(rest.warnings ?? [])];
  let text = rest.text;
  if (textCut) {
    // 상한에서 멈춰 만들었으므로 전체 길이는 모른다. 잘림 경고는 맨 앞에 — 개요는 경고를 3개만 보인다
    warnings.unshift(`본문이 길어 앞의 ${n(MAX_EXTRACT_CHARS)}자만 읽었습니다`);
    text = text.slice(0, MAX_EXTRACT_CHARS);
  } else if (text.length > MAX_EXTRACT_CHARS) {
    warnings.unshift(`본문이 ${n(text.length)}자라 앞의 ${n(MAX_EXTRACT_CHARS)}자만 읽었습니다`);
    text = text.slice(0, MAX_EXTRACT_CHARS);
  }
  if (!text.trim() && rest.tables.length === 0) {
    throw new AttachmentReadError('파일에서 읽을 글이 없습니다.');
  }
  // 글자 인식으로 읽었다는 안내가 맨 앞 — 개요는 경고를 3개만 보이고, 이것이 숫자를 믿는 정도를 정한다
  if (scanned) warnings.unshift(SCAN_WARNING);
  return { ...rest, text, warnings };
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
      ...(t.caption ? { caption: t.caption } : {}),
      ...(t.truncated && (t.truncated.rows || t.truncated.cols) ? { truncated: true } : {}),
    })),
    warnings: extract.warnings,
  };
}
