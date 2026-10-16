import Papa from 'papaparse';
import { MAX_TABLE_COLS, MAX_TABLE_ROWS } from './limits';
import { buildTable, captionAbove, detectHeader } from './header';
import type { Cell, ExtractedTable, TableMerge } from './types';

/**
 * 엑셀·CSV를 계산용 표로 읽는다.
 *
 * `spreadsheet.ts`는 검색용 마크다운 글을 만든다(숫자도 글자). 여기는 표 엔진이
 * 합계·필터를 계산할 수 있도록 **숫자는 숫자로, 병합은 주인 칸에만 값**으로 남긴다.
 * 두 경로의 출력은 달라야 하므로 `spreadsheet.ts`는 건드리지 않는다.
 */

/** 표 한 장이 되기 전의 격자. 좌표는 모두 0부터. */
interface Grid {
  cells: Cell[][];
  merges: TableMerge[];
}

const isBlank = (c: Cell | undefined) => c == null || (typeof c === 'string' && c.trim() === '');

/**
 * 빈 행 2줄 이상을 경계로 표를 나누고, 양 끝의 빈 행·빈 열을 다듬는다.
 * 세로 병합이 덮은 행은 다른 칸이 비어 있어도 빈 행이 아니다.
 */
function splitBlocks(cells: Cell[][], merges: TableMerge[]): Grid[] {
  const covered = new Set<number>();
  for (const m of merges) {
    if (isBlank(cells[m.row]?.[m.col])) continue;
    for (let r = m.row; r < m.row + m.rows; r += 1) covered.add(r);
  }
  const blank = (r: number) => !covered.has(r) && cells[r].every(isBlank);

  const ranges: [number, number][] = [];
  let start = -1;
  let blankRun = 0;
  for (let r = 0; r < cells.length; r += 1) {
    if (blank(r)) {
      blankRun += 1;
      // 경계를 넘어선 순간 한 번만 끊는다
      if (blankRun === 2 && start >= 0) {
        ranges.push([start, r - 2]);
        start = -1;
      }
      continue;
    }
    blankRun = 0;
    if (start < 0) start = r;
  }
  if (start >= 0) ranges.push([start, cells.length - 1]);

  const grids: Grid[] = [];
  for (const [rawTop, rawBottom] of ranges) {
    let top = rawTop;
    let bottom = rawBottom;
    while (top < bottom && blank(top)) top += 1;
    while (bottom > top && blank(bottom)) bottom -= 1;

    let left = Infinity;
    let right = -1;
    for (let r = top; r <= bottom; r += 1) {
      cells[r].forEach((c, i) => {
        if (!isBlank(c)) {
          left = Math.min(left, i);
          right = Math.max(right, i);
        }
      });
    }
    if (right < 0) continue;

    const width = right - left + 1;
    const block = cells.slice(top, bottom + 1).map((row) => row.slice(left, right + 1));
    // 좌표를 옮기고 다듬은 영역 밖으로 나간 병합은 줄인다
    const shifted: TableMerge[] = [];
    for (const m of merges) {
      const row = m.row - top;
      const col = m.col - left;
      if (row < 0 || col < 0 || row >= block.length || col >= width) continue;
      const rows = Math.min(m.rows, block.length - row);
      const cols = Math.min(m.cols, width - col);
      if (rows > 1 || cols > 1) shifted.push({ row, col, rows, cols });
    }
    grids.push({ cells: block, merges: shifted });
  }
  return grids;
}

/** 칸 값을 숫자·글자·빈칸으로. 병합 복사본 정리는 호출자가 한다. */
function toCell(value: unknown): Cell {
  if (value == null) return null;
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'string') return value.trim() === '' ? null : value.trim();
  if (typeof value === 'boolean') return value ? 'TRUE' : 'FALSE';
  if (value instanceof Date) {
    // exceljs는 엑셀 날짜를 UTC 기준 Date로 준다 — 로컬 getter를 쓰면 서쪽 시간대에서 하루 밀린다
    const y = value.getUTCFullYear();
    const m = String(value.getUTCMonth() + 1).padStart(2, '0');
    const d = String(value.getUTCDate()).padStart(2, '0');
    return `${y}-${m}-${d}`;
  }
  if (typeof value === 'object') {
    const obj = value as Record<string, unknown>;
    // 수식 칸은 수식이 아니라 계산 결과
    if ('result' in obj) return toCell(obj.result);
    if (Array.isArray(obj.richText)) {
      return toCell(obj.richText.map((p: { text?: string }) => p.text ?? '').join(''));
    }
    if ('text' in obj) return toCell(obj.text);
    if ('error' in obj) return toCell(String(obj.error));
  }
  return null;
}

function columnNumber(letters: string): number {
  let n = 0;
  for (const ch of letters) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n;
}

/** 'B2:D4' → 0부터의 병합 영역. */
function parseRange(range: string): TableMerge | null {
  const m = /^([A-Z]+)(\d+):([A-Z]+)(\d+)$/.exec(range.toUpperCase());
  if (!m) return null;
  const col = columnNumber(m[1]) - 1;
  const row = Number(m[2]) - 1;
  return { row, col, rows: Number(m[4]) - row, cols: columnNumber(m[3]) - col };
}

/** 머리글 위의 줄들을 줄마다 한 줄 글로 이어 캡션 후보로. */
function captionFor(grid: Grid): string | undefined {
  const { from } = detectHeader(grid.cells, grid.merges);
  const lines = grid.cells.slice(0, from).map((row) => row.filter((c) => !isBlank(c)).join(' '));
  return captionAbove(lines);
}

function truncationOf(
  colsCut: number | undefined,
  rowsCut: number | undefined,
  isLast: boolean
): { rows?: number; cols?: number } | undefined {
  const t: { rows?: number; cols?: number } = {};
  if (colsCut) t.cols = colsCut;
  // 행은 끝에서 잘렸으므로 마지막 표가 잘린 표다
  if (rowsCut && isLast) t.rows = rowsCut;
  return Object.keys(t).length ? t : undefined;
}

export async function readXlsxTables(
  bytes: Buffer
): Promise<{ tables: ExtractedTable[]; sheets: string[]; warnings: string[] }> {
  // exceljs는 무겁다. 표 문서를 올릴 때만 불러온다.
  const ExcelJS = (await import('exceljs')).default;
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(bytes as unknown as ArrayBuffer);

  const tables: ExtractedTable[] = [];
  const sheets: string[] = [];
  const warnings: string[] = [];

  workbook.eachSheet((ws) => {
    // 숨긴 시트는 대개 계산용 보조 자료라 본문이 아니다.
    if (ws.state === 'hidden' || ws.state === 'veryHidden') {
      warnings.push(`숨긴 시트 제외: ${ws.name}`);
      return;
    }
    sheets.push(ws.name);

    const cells: Cell[][] = [];
    // 값이 있는 마지막 행·열(1부터). 상한을 넘어도 세어야 "N개 중 200개"를 말할 수 있다.
    let lastRow = 0;
    let lastCol = 0;
    ws.eachRow({ includeEmpty: false }, (row) => {
      const values = Array.isArray(row.values) ? row.values : [];
      const inRange = row.number <= MAX_TABLE_ROWS;
      const out: Cell[] = [];
      let any = false;
      for (let i = 1; i < values.length; i += 1) {
        const cell = toCell(values[i]);
        if (cell == null) continue;
        any = true;
        lastCol = Math.max(lastCol, i);
        if (inRange && i <= MAX_TABLE_COLS) {
          while (out.length < i - 1) out.push(null);
          out.push(cell);
        }
      }
      if (any) lastRow = Math.max(lastRow, row.number);
      if (inRange) {
        while (cells.length < row.number - 1) cells.push([]);
        cells[row.number - 1] = out;
      }
    });

    const rowCap = Math.min(lastRow, MAX_TABLE_ROWS);
    const colCap = Math.min(lastCol, MAX_TABLE_COLS);
    if (rowCap === 0 || colCap === 0) return;
    cells.length = rowCap;
    for (let r = 0; r < rowCap; r += 1) {
      while (cells[r].length < colCap) cells[r].push(null);
    }

    // 병합: exceljs는 병합된 칸마다 주인 값을 복사해 둔다 — 주인 칸만 남긴다
    const merges: TableMerge[] = [];
    const ranges = (ws.model as unknown as { merges?: string[] }).merges ?? [];
    for (const range of ranges) {
      const m = parseRange(range);
      if (!m || m.row >= rowCap || m.col >= colCap) continue;
      const rows = Math.min(m.rows, rowCap - m.row);
      const cols = Math.min(m.cols, colCap - m.col);
      for (let r = m.row; r < m.row + rows; r += 1) {
        for (let c = m.col; c < m.col + cols; c += 1) {
          if (r !== m.row || c !== m.col) cells[r][c] = null;
        }
      }
      if (rows > 1 || cols > 1) merges.push({ row: m.row, col: m.col, rows, cols });
    }

    const colsCut = lastCol > MAX_TABLE_COLS ? lastCol : undefined;
    const rowsCut = lastRow > MAX_TABLE_ROWS ? lastRow : undefined;
    if (colsCut) warnings.push(`${ws.name} 시트: 열 ${colsCut}개 중 ${MAX_TABLE_COLS}개만 읽었습니다`);
    if (rowsCut) warnings.push(`${ws.name} 시트: 행 ${rowsCut}개 중 ${MAX_TABLE_ROWS}개만 읽었습니다`);

    const blocks = splitBlocks(cells, merges);
    blocks.forEach((grid, i) => {
      tables.push(
        buildTable(
          tables.length + 1,
          i === 0 ? ws.name : `${ws.name} 표 ${i + 1}`,
          grid.cells,
          grid.merges,
          captionFor(grid),
          truncationOf(colsCut, rowsCut, i === blocks.length - 1)
        )
      );
    });
  });

  return { tables, sheets, warnings };
}

export function readCsvTables(bytes: Buffer): { tables: ExtractedTable[]; warnings: string[] } {
  // 공공기관 CSV는 EUC-KR인 경우가 많다. UTF-8로 읽어 깨지면 다시 시도한다 (spreadsheet.ts와 같은 판정).
  let text = new TextDecoder('utf-8').decode(bytes);
  if (text.includes('�')) {
    try {
      text = new TextDecoder('euc-kr').decode(bytes);
    } catch {
      // euc-kr 디코더가 없는 런타임이면 원래 결과를 쓴다
    }
  }
  // Excel이 붙이는 BOM을 떼지 않으면 첫 열 머리글에 섞인다
  text = text.replace(/^﻿/, '');

  // skipEmptyLines를 쓰지 않는다 — 빈 줄 2줄이 표 경계라 빈 줄이 남아야 한다.
  const parsed = Papa.parse<string[]>(text);
  const rows = (parsed.data ?? []).filter(Array.isArray);

  const warnings: string[] = [];
  let width = 0;
  for (const row of rows) {
    // 뒤쪽 빈 칸은 폭으로 세지 않는다
    let w = row.length;
    while (w > 0 && !String(row[w - 1] ?? '').trim()) w -= 1;
    width = Math.max(width, w);
  }
  const colsCut = width > MAX_TABLE_COLS ? width : undefined;
  const rowsCut = rows.length > MAX_TABLE_ROWS ? rows.length : undefined;
  if (colsCut) warnings.push(`열 ${colsCut}개 중 ${MAX_TABLE_COLS}개만 읽었습니다`);
  if (rowsCut) warnings.push(`행 ${rowsCut}개 중 ${MAX_TABLE_ROWS}개만 읽었습니다`);
  width = Math.min(width, MAX_TABLE_COLS);

  // CSV 칸은 숫자처럼 보여도 글자로 둔다 — 앞자리 0 코드('0012')를 지키려는 것이고 숫자 해석은 표 엔진의 몫이다.
  const cells: Cell[][] = rows
    .slice(0, MAX_TABLE_ROWS)
    .map((row) => Array.from({ length: width }, (_, c) => toCell(String(row[c] ?? ''))));

  const blocks = splitBlocks(cells, []);
  const tables = blocks.map((grid, i) =>
    buildTable(
      i + 1,
      `표 ${i + 1}`,
      grid.cells,
      grid.merges,
      captionFor(grid),
      truncationOf(colsCut, rowsCut, i === blocks.length - 1)
    )
  );
  return { tables, warnings };
}
