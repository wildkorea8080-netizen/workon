import type { NodaParsedDocument, NodaParsedTable } from '@/lib/noda';
import { buildTable } from './header';
import { MAX_TABLE_COLS, MAX_TABLE_ROWS } from './limits';
import { truncationWarnings } from './tables-hwpx';
import type { Cell, ExtractedTable, TableMerge } from './types';

/**
 * 글자 층이 없는 PDF(스캔본)를 NODA `/parse`가 읽어 준 결과를 첨부 읽기 형태로 바꾼다.
 * NODA 응답은 믿지 않고(칸 주소·병합·크기가 이상할 수 있다) 칸에서 격자를 다시 만든다.
 */

/** 페이지당 이 글자 수에 못 미치면 텍스트 레이어가 없다고 본다. */
const MIN_CHARS_PER_PAGE = 50;

/**
 * 추출된 텍스트가 너무 적으면 스캔본으로 판단한다.
 *
 * 페이지 수로 나눠 보는 이유: 표지만 텍스트고 본문이 스캔인 문서가 흔하다.
 * 전체 길이만 보면 그런 문서를 놓친다.
 */
export function isLikelyScanned(text: string, pageCount: number): boolean {
  if (pageCount <= 0) return false;
  const density = text.replace(/\s/g, '').length / pageCount;
  return density < MIN_CHARS_PER_PAGE;
}

export const SCAN_WARNING = '글자 층이 없는 PDF라 글자 인식(OCR)으로 읽었습니다 — 숫자·글자가 원문과 다를 수 있습니다';

const isCount = (v: unknown): v is number => typeof v === 'number' && Number.isInteger(v) && v >= 0;
const span = (v: unknown): number => (typeof v === 'number' && Number.isInteger(v) && v >= 1 ? v : 1);
/** 쓸 수 있는 크기 힌트(양의 정수)만. 글자·음수·소수는 없는 것으로 */
const hint = (v: unknown): number | null => (typeof v === 'number' && Number.isInteger(v) && v >= 1 ? v : null);

interface Placed {
  r: number;
  c: number;
  rows: number;
  cols: number;
  text: string | null;
}

function toGrid(t: NodaParsedTable): {
  cells: Cell[][];
  merges: TableMerge[];
  truncated?: { rows?: number; cols?: number };
  dropped: number;
} | null {
  const placed: Placed[] = [];
  let height = 0;
  let width = 0;
  for (const c of Array.isArray(t.cells) ? t.cells : []) {
    if (!c || !isCount(c.r) || !isCount(c.c)) continue;
    const rows = span(c.rowspan);
    const cols = span(c.colspan);
    const text = typeof c.text === 'string' && c.text.trim() !== '' ? c.text.trim() : null;
    placed.push({ r: c.r, c: c.c, rows, cols, text });
    if (c.r + rows > height) height = c.r + rows;
    if (c.c + cols > width) width = c.c + cols;
  }
  if (placed.length === 0) return null;

  // NODA가 알려 준 크기는 위쪽 힌트일 뿐이다 — 칸이 그 밖에 있으면 건너뛰고 알린다
  const rowHint = hint(t.n_rows);
  const colHint = hint(t.n_cols);
  if (rowHint !== null && rowHint < height) height = rowHint;
  if (colHint !== null && colHint < width) width = colHint;
  const rows = Math.min(height, MAX_TABLE_ROWS);
  const cols = Math.min(width, MAX_TABLE_COLS);

  const cells: Cell[][] = Array.from({ length: rows }, () => Array.from({ length: cols }, () => null));
  const merges: TableMerge[] = [];
  let dropped = 0;
  for (const p of placed) {
    if (p.r >= height || p.c >= width) {
      dropped += 1;
      continue;
    }
    if (p.r >= rows || p.c >= cols) continue; // 상한에 잘림 — truncated로 알린다
    cells[p.r][p.c] = p.text;
    const mr = Math.min(p.rows, rows - p.r);
    const mc = Math.min(p.cols, cols - p.c);
    if (mr > 1 || mc > 1) merges.push({ row: p.r, col: p.c, rows: mr, cols: mc });
  }

  const truncated: { rows?: number; cols?: number } = {};
  if (height > MAX_TABLE_ROWS) truncated.rows = height;
  if (width > MAX_TABLE_COLS) truncated.cols = width;
  return truncated.rows || truncated.cols ? { cells, merges, truncated, dropped } : { cells, merges, dropped };
}

export function parsedToExtract(doc: NodaParsedDocument): {
  text: string;
  tables: ExtractedTable[];
  pages: number;
  warnings: string[];
} {
  const lines: string[] = [];
  for (const b of Array.isArray(doc.blocks) ? doc.blocks : []) {
    if (!b || b.type === 'footer') continue;
    if (typeof b.text === 'string' && b.text.trim() !== '') lines.push(b.text);
  }

  const tables: ExtractedTable[] = [];
  const warnings: string[] = [];
  for (const raw of Array.isArray(doc.tables) ? doc.tables : []) {
    const grid = raw ? toGrid(raw) : null;
    if (!grid) continue;
    const index = tables.length + 1;
    const title = `표 ${index}`;
    const caption = typeof raw.caption === 'string' && raw.caption.trim() !== '' ? raw.caption.trim() : undefined;
    tables.push(buildTable(index, title, grid.cells, grid.merges, caption, grid.truncated));
    warnings.push(...truncationWarnings(title, grid.truncated));
    if (grid.dropped) {
      warnings.push(`${title}: 표 범위 밖 칸 ${grid.dropped.toLocaleString('ko-KR')}개를 건너뛰었습니다`);
    }
  }

  return { text: lines.join('\n'), tables, pages: isCount(doc.pages) ? doc.pages : 0, warnings };
}
