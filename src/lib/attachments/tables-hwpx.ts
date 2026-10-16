import { openHwpx, readEntry } from '../doc-fill/hwpx-core';
import { paragraphPrefix, scanTags, unescapeXml } from '../doc-fill/xml-scan';
import { stripPrivateUse } from '../hwp';
import { buildTable, captionAbove } from './header';
import { MAX_TABLE_COLS, MAX_TABLE_ROWS } from './limits';
import type { ExtractedTable, TableMerge } from './types';

/**
 * HWPX 표를 계산용 칸 배열로 읽는다. 공공기관은 자료를 한글 표 양식으로 모으는 일이 많다.
 *
 * 고치지 않으므로 파서를 써도 되지만, 양식 채우기(hwpx-auto.ts의 scanTables)가 검증한
 * 같은 훑기 규칙을 쓴다 — 칸 글은 그 칸에 **바로 든** 문단(칸이 열릴 때의 문단 깊이에서 열린 문단)만.
 * 안쪽 표의 글은 바깥 칸에 넣지 않고 따로 표가 된다. 섞이면 바깥 칸 값이 엉뚱한 글이 된다.
 */

const ATTR = (name: string) => new RegExp(`\\s${name}\\s*=\\s*(?:"(\\d+)"|'(\\d+)')`);
const COL_ADDR = ATTR('colAddr');
const ROW_ADDR = ATTR('rowAddr');
const COL_SPAN = ATTR('colSpan');
const ROW_SPAN = ATTR('rowSpan');

function attrNum(src: string, re: RegExp): number | null {
  const m = src.match(re);
  return m ? Number(m[1] ?? m[2]) : null;
}

interface RawCell {
  row: number;
  col: number;
  rows: number;
  cols: number;
  /** 바로 든 문단의 글 */
  lines: string[];
}

interface RawTable {
  cells: RawCell[];
  caption?: string;
}

/** 한 구역의 표들. 표가 시작하는 순서(바깥 표 → 안쪽 표) */
function scanSectionTables(xml: string): RawTable[] {
  const prefix = paragraphPrefix(xml);
  const P = `${prefix}:p`;
  const T = `${prefix}:t`;
  const TBL = `${prefix}:tbl`;
  const TR = `${prefix}:tr`;
  const TC = `${prefix}:tc`;
  const ADDR = `${prefix}:cellAddr`;
  const SPAN = `${prefix}:cellSpan`;
  const TAB = `${prefix}:tab`;
  const BR = `${prefix}:lineBreak`;
  /** 묶음 빈칸·고정폭 빈칸·반각 빈칸. HWP 5.0의 30·31처럼 띄어쓰기로 읽는다 */
  const SPACES = new Set([`${prefix}:nbSpace`, `${prefix}:fwSpace`, `${prefix}:hwSpace`]);
  const CAPTION = `${prefix}:caption`;

  interface ParaFrame {
    parts: string[];
    hasTable: boolean;
  }
  interface TableFrame {
    table: RawTable;
    row: number;
    col: number;
    cell: (RawCell & { addr: { row: number | null; col: number | null } }) | null;
    /** 칸이 열릴 때의 문단 깊이 — 이 깊이에서 열리는 문단이 칸에 바로 든 문단 */
    depth: number;
    /** 표 자신의 캡션(hp:caption) 안이면 그 문단 깊이와 글 */
    caption: { depth: number; lines: string[] } | null;
  }

  const pStack: ParaFrame[] = [];
  const frames: TableFrame[] = [];
  const out: RawTable[] = [];
  /** 최상위 문단 글. 표를 품은 최상위 문단을 지나면 비운다 — 표 바로 뒤의 표가 앞 표의 caption을 물려받지 않게 */
  let topLines: string[] = [];
  let inText = false;
  let cursor = 0;

  const closeCell = (f: TableFrame) => {
    const c = f.cell;
    if (!c) return;
    if (c.addr.row !== null && c.addr.col !== null) {
      c.row = c.addr.row;
      c.col = c.addr.col;
    }
    f.table.cells.push({ row: c.row, col: c.col, rows: c.rows, cols: c.cols, lines: c.lines });
    f.cell = null;
  };

  for (const tag of scanTags(xml)) {
    const para = pStack.length > 0 ? pStack[pStack.length - 1] : null;
    if (inText) {
      // <hp:t> 안의 글과 탭·줄바꿈. 글은 가장 안쪽 문단 몫이다
      if (para && cursor < tag.start) para.parts.push(unescapeXml(xml.slice(cursor, tag.start)));
      if (tag.name === T && tag.kind === 'close') inText = false;
      else {
        if (para && tag.name === TAB) para.parts.push('\t');
        else if (para && tag.name === BR) para.parts.push('\n');
        else if (para && SPACES.has(tag.name)) para.parts.push(' ');
        cursor = tag.end;
      }
      continue;
    }
    if (tag.name === T && tag.kind === 'open') {
      inText = true;
      cursor = tag.end;
      continue;
    }

    const top = frames.length > 0 ? frames[frames.length - 1] : null;
    if (tag.name === P) {
      if (tag.kind === 'open') pStack.push({ parts: [], hasTable: false });
      else if (tag.kind === 'close') {
        const closed = pStack.pop();
        if (!closed) continue;
        const text = stripPrivateUse(closed.parts.join(''));
        if (top?.caption) {
          if (pStack.length === top.caption.depth) top.caption.lines.push(text);
        } else if (top?.cell && pStack.length === top.depth) top.cell.lines.push(text);
        if (pStack.length === 0) {
          if (closed.hasTable) topLines = [];
          else topLines.push(text);
        }
      }
    } else if (tag.name === TBL) {
      if (tag.kind === 'open') {
        if (pStack.length > 0) pStack[0].hasTable = true;
        // 안쪽 표도 품은 최상위 문단이 같으므로 caption이 같다
        const table: RawTable = { cells: [], caption: captionAbove(topLines) };
        out.push(table);
        frames.push({ table, row: -1, col: 0, cell: null, depth: 0, caption: null });
      } else if (tag.kind === 'close' && top) {
        closeCell(top);
        frames.pop();
      }
    } else if (!top) {
      continue;
    } else if (tag.name === CAPTION) {
      // 표에 달린 캡션이 있으면 그것이 표 제목이다 — 앞 문단보다 정확하다
      if (tag.kind === 'open') top.caption = { depth: pStack.length, lines: [] };
      else if (tag.kind === 'close' && top.caption) {
        const text = top.caption.lines.join('\n').trim();
        if (text) top.table.caption = text;
        top.caption = null;
      }
    } else if (tag.name === TR && tag.kind === 'open') {
      top.row++;
      top.col = 0;
    } else if (tag.name === TC) {
      if (tag.kind === 'open') {
        closeCell(top);
        top.cell = { row: top.row, col: top.col++, rows: 1, cols: 1, lines: [], addr: { row: null, col: null } };
        top.depth = pStack.length;
      } else if (tag.kind === 'close') {
        closeCell(top);
      }
    } else if (top.cell && pStack.length === top.depth && tag.kind !== 'close' && (tag.name === ADDR || tag.name === SPAN)) {
      const src = xml.slice(tag.start, tag.end);
      if (tag.name === ADDR) {
        top.cell.addr = { col: attrNum(src, COL_ADDR), row: attrNum(src, ROW_ADDR) };
      } else {
        top.cell.cols = Math.max(1, attrNum(src, COL_SPAN) ?? 1);
        top.cell.rows = Math.max(1, attrNum(src, ROW_SPAN) ?? 1);
      }
    }
  }
  return out;
}

/** 칸 배열로. 상한을 넘으면 잘라 읽고 원래 크기를 돌려준다. 칸이 없으면 null */
function toGrid(raw: RawTable): {
  cells: (string | null)[][];
  merges: TableMerge[];
  truncated?: { rows?: number; cols?: number };
} | null {
  if (raw.cells.length === 0) return null;
  // 칸이 수십만 개일 수 있다 — Math.max(...배열)은 인자 수 상한에 걸려 던진다
  let height = 0;
  let width = 0;
  for (const c of raw.cells) {
    if (c.row + c.rows > height) height = c.row + c.rows;
    if (c.col + c.cols > width) width = c.col + c.cols;
  }
  const rows = Math.min(height, MAX_TABLE_ROWS);
  const cols = Math.min(width, MAX_TABLE_COLS);

  const cells: (string | null)[][] = Array.from({ length: rows }, () => Array.from({ length: cols }, () => null));
  const merges: TableMerge[] = [];
  for (const c of raw.cells) {
    if (c.row >= rows || c.col >= cols) continue;
    const text = c.lines.join('\n').trim();
    cells[c.row][c.col] = text === '' ? null : text;
    const mr = Math.min(c.rows, rows - c.row);
    const mc = Math.min(c.cols, cols - c.col);
    if (mr > 1 || mc > 1) merges.push({ row: c.row, col: c.col, rows: mr, cols: mc });
  }

  const truncated: { rows?: number; cols?: number } = {};
  if (height > MAX_TABLE_ROWS) truncated.rows = height;
  if (width > MAX_TABLE_COLS) truncated.cols = width;
  return truncated.rows || truncated.cols ? { cells, merges, truncated } : { cells, merges };
}

/** '표 3: 행 25,000개 중 20,000개만 읽었습니다'. HWP 5.0 표를 조립하는 쪽도 같은 문구를 쓴다 */
export function truncationWarnings(title: string, truncated?: { rows?: number; cols?: number }): string[] {
  const n = (v: number) => v.toLocaleString('ko-KR');
  const out: string[] = [];
  if (truncated?.rows) out.push(`${title}: 행 ${n(truncated.rows)}개 중 ${n(MAX_TABLE_ROWS)}개만 읽었습니다`);
  if (truncated?.cols) out.push(`${title}: 열 ${n(truncated.cols)}개 중 ${n(MAX_TABLE_COLS)}개만 읽었습니다`);
  return out;
}

/** 머리말·꼬리말 안의 표도 본문 표처럼 읽는다(색인과 같다) — 그런 표가 있으면 번호가 그만큼 밀린다 */
export async function readHwpxTables(bytes: Buffer): Promise<{ tables: ExtractedTable[]; warnings: string[] }> {
  const doc = await openHwpx(bytes);
  const tables: ExtractedTable[] = [];
  const warnings: string[] = [];
  for (const name of doc.sections) {
    for (const raw of scanSectionTables(await readEntry(doc.zip, name))) {
      const grid = toGrid(raw);
      if (!grid) continue;
      const index = tables.length + 1;
      const title = `표 ${index}`;
      tables.push(buildTable(index, title, grid.cells, grid.merges, raw.caption, grid.truncated));
      warnings.push(...truncationWarnings(title, grid.truncated));
    }
  }
  return { tables, warnings };
}
