import type { Cell, ExtractedTable, TableMerge } from './types';

/**
 * 표의 머리글을 추정하고 열 이름을 만든다.
 *
 * 공공기관 표는 맨 윗줄이 머리글이 아닌 경우가 흔하다(제목 줄, 단위 줄).
 * 2단 머리글('예산' 아래 '본예산·추경')도 흔해서, 첫 줄만 쓰면 열 이름이 겹친다.
 */

const MAX_HEADER_ROWS = 3;

const NUMERIC_TEXT = /^[+-]?[\d,]+(\.\d+)?%?$/;

function isEmpty(cell: Cell | undefined): boolean {
  return cell == null || (typeof cell === 'string' && cell.trim() === '');
}

/** 글자 칸. 숫자(또는 숫자처럼 생긴 글)는 값이지 머리글이 아니다 — CSV는 숫자도 글자로 읽힌다. */
function isTextCell(cell: Cell | undefined): boolean {
  return typeof cell === 'string' && cell.trim() !== '' && !NUMERIC_TEXT.test(cell.trim());
}

/** 그 행에 걸친 가로 병합이 있는가. */
function hasHorizontalMerge(row: number, merges: TableMerge[]): boolean {
  return merges.some((m) => m.cols > 1 && row >= m.row && row < m.row + m.rows);
}

export function detectHeader(
  cells: Cell[][],
  merges: TableMerge[]
): { from: number; to: number } {
  const last = cells.length - 1;
  let from = -1;
  for (let r = 0; r <= last; r += 1) {
    const filled = cells[r].filter((c) => !isEmpty(c));
    if (filled.length >= 2 && filled.filter(isTextCell).length * 2 > filled.length) {
      from = r;
      break;
    }
  }
  // 머리글처럼 보이는 줄이 없으면 첫 줄을 쓴다
  if (from < 0) return { from: 0, to: 0 };

  // 가로 병합이 있으면 그 아래 줄이 하위 머리글이다. 최대 3줄.
  let to = from;
  while (to - from + 1 < MAX_HEADER_ROWS && to < last && hasHorizontalMerge(to, merges)) {
    to += 1;
  }
  return { from, to };
}

export function columnNames(
  cells: Cell[][],
  merges: TableMerge[],
  header: { from: number; to: number }
): string[] {
  const width = Math.max(0, ...cells.map((r) => r.length));
  const rowsCount = header.to - header.from + 1;

  // 머리글 줄만 떼어 병합을 주인 값으로 채운다 (머리글 밖으로 번지는 병합은 자른다)
  const grid: Cell[][] = Array.from({ length: rowsCount }, (_, i) =>
    Array.from({ length: width }, (_, c) => cells[header.from + i]?.[c] ?? null)
  );
  for (const m of merges) {
    const owner = cells[m.row]?.[m.col] ?? null;
    if (isEmpty(owner)) continue;
    for (let r = Math.max(m.row, header.from); r < Math.min(m.row + m.rows, header.to + 1); r += 1) {
      for (let c = m.col; c < Math.min(m.col + m.cols, width); c += 1) {
        grid[r - header.from][c] = owner;
      }
    }
  }

  const seen = new Map<string, number>();
  return Array.from({ length: width }, (_, c) => {
    const parts: string[] = [];
    for (let r = 0; r < rowsCount; r += 1) {
      const v = grid[r][c];
      if (isEmpty(v)) continue;
      const text = String(v).trim();
      // 세로 병합이나 반복으로 위아래가 같은 글이면 한 번만
      if (parts[parts.length - 1] !== text) parts.push(text);
    }
    const base = parts.join(' / ') || `열 ${c + 1}`;
    const count = (seen.get(base) ?? 0) + 1;
    seen.set(base, count);
    return count === 1 ? base : `${base} (${count})`;
  });
}

/** 표 바로 위 비지 않은 줄 하나. */
export function captionAbove(lines: string[]): string | undefined {
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const text = lines[i].trim();
    if (text) return text;
  }
  return undefined;
}

/** 표 한 장을 조립한다. 머리글·열 이름은 여기서 한 번만 정한다(엑셀·CSV·HWPX가 같이 쓴다). */
export function buildTable(
  index: number,
  title: string,
  cells: Cell[][],
  merges: TableMerge[],
  caption?: string,
  truncated?: { rows?: number; cols?: number }
): ExtractedTable {
  const header = detectHeader(cells, merges);
  const table: ExtractedTable = {
    id: `t${index}`,
    title,
    cells,
    merges,
    header,
    columns: columnNames(cells, merges, header),
  };
  if (caption) table.caption = caption;
  if (truncated) table.truncated = truncated;
  return table;
}
