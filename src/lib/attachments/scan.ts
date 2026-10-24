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

/** 겹침 검사에 쓰는 칸 수 예산 — 겹치는 병합을 잔뜩 보내도 시간이 늘지 않게. 넘으면 이후 병합은 풀어 1×1로 둔다 */
const OVERLAP_SCAN_BUDGET = 20_000_000;

function toGrid(t: NodaParsedTable): {
  cells: Cell[][];
  merges: TableMerge[];
  truncated?: { rows?: number; cols?: number };
  /** 힌트 밖 칸 */
  skipped: number;
  /** 병합 안(또는 같은 자리)에 놓여 건너뛴 칸 */
  overlapped: number;
  /** 겹쳐서 풀어 둔 병합 */
  unmerged: number;
} | null {
  const placed: Placed[] = [];
  for (const c of Array.isArray(t.cells) ? t.cells : []) {
    if (!c || !isCount(c.r) || !isCount(c.c)) continue;
    const text = typeof c.text === 'string' && c.text.trim() !== '' ? c.text.trim() : null;
    placed.push({ r: c.r, c: c.c, rows: span(c.rowspan), cols: span(c.colspan), text });
  }
  if (placed.length === 0) return null;

  // 격자 크기는 칸의 **원점**으로만 잰다 — 칸 하나의 엄청난 rowspan·colspan이 격자를 부풀리면
  // 널로 가득한 표와 가짜 잘림 경고가 나온다. 병합은 이 범위 안으로 줄인다
  let height = 0;
  let width = 0;
  for (const p of placed) {
    if (p.r + 1 > height) height = p.r + 1;
    if (p.c + 1 > width) width = p.c + 1;
  }
  // NODA가 알려 준 크기는 위쪽 힌트일 뿐이다 — 칸이 그 밖에 있으면 건너뛰고 알린다
  const rowHint = hint(t.n_rows);
  const colHint = hint(t.n_cols);
  if (rowHint !== null && rowHint < height) height = rowHint;
  if (colHint !== null && colHint < width) width = colHint;
  const rows = Math.min(height, MAX_TABLE_ROWS);
  const cols = Math.min(width, MAX_TABLE_COLS);

  // 주인 칸이 먼저 오도록 (r,c) 순으로 — 병합 안에 놓인 칸이 도착 순서 때문에 값을 덮어쓰지 않게
  placed.sort((x, y) => x.r - y.r || x.c - y.c);

  const cells: Cell[][] = Array.from({ length: rows }, () => Array.from({ length: cols }, () => null));
  const taken = new Uint8Array(rows * cols); // 값이 놓였거나 병합에 덮인 자리
  const merges: TableMerge[] = [];
  let skipped = 0;
  let overlapped = 0;
  let unmerged = 0;
  let budget = OVERLAP_SCAN_BUDGET;
  for (const p of placed) {
    if (p.r >= height || p.c >= width) {
      skipped += 1;
      continue;
    }
    if (p.r >= rows || p.c >= cols) continue; // 상한에 잘림 — truncated로 알린다
    if (taken[p.r * cols + p.c]) {
      // 다른 칸의 병합 안(또는 같은 자리) — 덮인 칸은 null로 둔다. 표 엔진은 덮인 칸의 글을 값으로 믿는다
      // 글이 없는 덮인 칸(NODA가 병합 자리를 빈 칸으로 나열)은 잃는 것이 없어 알리지 않는다
      if (p.text !== null) overlapped += 1;
      continue;
    }
    cells[p.r][p.c] = p.text;
    const mr = Math.min(p.rows, height - p.r, rows - p.r);
    const mc = Math.min(p.cols, width - p.c, cols - p.c);
    taken[p.r * cols + p.c] = 1;
    if (mr <= 1 && mc <= 1) continue;
    // 먼저 놓인 칸·병합과 겹치면 병합은 풀고 이 칸만 둔다 — merges에 겹치는 범위가 없어야 한다
    let clear = budget >= mr * mc;
    if (clear) {
      budget -= mr * mc;
      for (let r = p.r; clear && r < p.r + mr; r += 1) {
        for (let c = p.c; c < p.c + mc; c += 1) {
          if ((r !== p.r || c !== p.c) && taken[r * cols + c]) {
            clear = false;
            break;
          }
        }
      }
    }
    if (!clear) {
      unmerged += 1;
      continue;
    }
    for (let r = p.r; r < p.r + mr; r += 1) taken.fill(1, r * cols + p.c, r * cols + p.c + mc);
    merges.push({ row: p.r, col: p.c, rows: mr, cols: mc });
  }

  const truncated: { rows?: number; cols?: number } = {};
  if (height > MAX_TABLE_ROWS) truncated.rows = height;
  if (width > MAX_TABLE_COLS) truncated.cols = width;
  const out = { cells, merges, skipped, overlapped, unmerged };
  return truncated.rows || truncated.cols ? { ...out, truncated } : out;
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
    const n = (v: number) => v.toLocaleString('ko-KR');
    if (grid.skipped) warnings.push(`${title}: 표 범위 밖 칸 ${n(grid.skipped)}개를 건너뛰었습니다`);
    if (grid.overlapped) warnings.push(`${title}: 병합 안에 놓인 칸 ${n(grid.overlapped)}개를 건너뛰었습니다`);
    if (grid.unmerged) warnings.push(`${title}: 겹친 병합 ${n(grid.unmerged)}개를 풀었습니다`);
  }

  return { text: lines.join('\n'), tables, pages: isCount(doc.pages) ? doc.pages : 0, warnings };
}
