import { MAX_CAPTION_CHARS } from './limits';
import type { Cell, ExtractedTable, TableMerge } from './types';

/**
 * 표의 머리글을 추정하고 열 이름을 만든다.
 *
 * 공공기관 표는 맨 윗줄이 머리글이 아닌 경우가 흔하다(제목 줄, 단위 줄).
 * 2단 머리글('예산' 아래 '본예산·추경')도 흔해서, 첫 줄만 쓰면 열 이름이 겹친다.
 */

const MAX_HEADER_ROWS = 3;

/**
 * 값으로 읽는 글. CSV·한글 표는 숫자도 글자로 온다.
 * 공공기관 표의 값 꼴: 증감 표시(△100·▲ 50), 회계식 음수 (1,234), 단위 접미사(1,000원·12.5%·30명),
 * 홀로 쓴 줄표('-' — 값 없음 표시). 이런 칸이 머리글로 잡히면 첫 데이터 행이 열 이름에 섞인다.
 */
const NUMBER_BODY = /^[+-]?[\d,]+(\.\d+)?$/;
const UNIT_SUFFIX = /\s*(%|원|천원|백만원|억원|명|건|개|톤)$/;
const DASH_ONLY = /^[-—–]$/;

export function isNumericText(text: string): boolean {
  let t = text.trim();
  if (DASH_ONLY.test(t)) return true;
  t = t.replace(/^[△▲]\s*/, '').replace(UNIT_SUFFIX, '');
  if (t.startsWith('(') && t.endsWith(')')) t = t.slice(1, -1).trim();
  return NUMBER_BODY.test(t);
}

function isEmpty(cell: Cell | undefined): boolean {
  return cell == null || (typeof cell === 'string' && cell.trim() === '');
}

/** 연도·월·분기처럼 값이 아니라 머리글로 쓰이는 숫자: 1900~2100, '2024년', '3월', '1분기', '2025년도'. */
const PERIOD_TEXT = /^\d+\s*(월|분기|년|년도)$/;
function isYearLike(cell: Cell | undefined): boolean {
  if (typeof cell === 'number') return Number.isInteger(cell) && cell >= 1900 && cell <= 2100;
  if (typeof cell !== 'string') return false;
  const t = cell.trim();
  if (/^\d{4}$/.test(t)) return Number(t) >= 1900 && Number(t) <= 2100;
  return PERIOD_TEXT.test(t);
}

/** 번호 매김 '(1)'·'(12)'은 회계식 음수가 아니라 항목 이름이다(머리글 판정에서만) */
const NUMBERING = /^\(\d{1,2}\)$/;
function isNumbering(cell: Cell | undefined): boolean {
  return typeof cell === 'string' && NUMBERING.test(cell.trim());
}

/** 값 칸 — 숫자나 숫자 꼴 글. 연도꼴과 번호 매김은 값으로 치지 않는다(머리글일 수 있다) */
function isPlainNumber(cell: Cell | undefined): boolean {
  if (isEmpty(cell) || isYearLike(cell) || isNumbering(cell)) return false;
  return typeof cell === 'number' || isNumericText(String(cell));
}

function yearCount(row: Cell[] | undefined): number {
  let count = 0;
  for (const c of row ?? []) if (isYearLike(c)) count += 1;
  return count;
}

/**
 * 머리글 근거 칸. 글자·번호 매김은 근거다. 연도꼴은 한 줄에 2개 이상이면('구분 | 2024 | 2025') 근거이고,
 * 하나뿐이면 **바로 아래 칸이 (연도꼴 아닌) 숫자일 때만** 근거다('구분 | 2025년' 위 '총무과 | 100').
 * '기준연도 | 2025' 아래 '부서 | 예산'처럼 아래가 글이면 메타 줄이라 근거가 아니다.
 */
function isHeaderEvidence(cells: Cell[][], r: number, c: number, years: number): boolean {
  const cell = cells[r][c];
  if (isEmpty(cell)) return false;
  if (isYearLike(cell)) return years >= 2 || isPlainNumber(cells[r + 1]?.[c]);
  if (isNumbering(cell)) return true;
  return typeof cell === 'string' && !isNumericText(cell);
}

/** 그 행에 걸친 가로 병합들. */
function horizontalMerges(row: number, merges: TableMerge[]): TableMerge[] {
  return merges.filter((m) => m.cols > 1 && row >= m.row && row < m.row + m.rows);
}

/**
 * 가로 병합 아래 줄이 하위 머리글인가. 아니면 그 줄은 데이터다.
 * - 숫자 칸이 있으면 데이터. 연도꼴('2025년')·번호('(1)')는 숫자로 치지 않는다 — 하위 머리글에 흔하다
 * - 머리글 줄의 가로 병합 범위 밖에 글이 있고 그 칸이 머리글 줄에서 내려온 세로 병합에 덮이지 않았으면 데이터 —
 *   진짜 하위 머리글 줄은 항목 열('구분')이 비었거나 위에서 세로로 병합돼 있다
 * - 병합된 칸마다 그 아래에 글이 하나는 있어야 하위 머리글
 */
function isSubHeaderRow(cells: Cell[][], row: number, merges: TableMerge[]): boolean {
  const below = cells[row + 1];
  if (!below) return false;
  if (below.some(isPlainNumber)) return false;

  const spans = horizontalMerges(row, merges);
  const coveredFromAbove = (c: number) =>
    merges.some((m) => m.row <= row && row + 1 < m.row + m.rows && c >= m.col && c < m.col + m.cols);
  for (let c = 0; c < below.length; c += 1) {
    if (isEmpty(below[c])) continue;
    const inSpan = spans.some((m) => c >= m.col && c < m.col + m.cols);
    if (!inSpan && !coveredFromAbove(c)) return false;
  }

  return spans.every((m) => {
    // 세로로도 이어진 병합은 아래 줄을 이미 덮고 있다
    if (row + 1 < m.row + m.rows) return true;
    for (let c = m.col; c < m.col + m.cols; c += 1) if (!isEmpty(below[c])) return true;
    return false;
  });
}

export function detectHeader(
  cells: Cell[][],
  merges: TableMerge[]
): { from: number; to: number } {
  const last = cells.length - 1;
  let from = -1;
  for (let r = 0; r <= last; r += 1) {
    const row = cells[r];
    const years = yearCount(row);
    let filled = 0;
    let evidence = 0;
    for (let c = 0; c < row.length; c += 1) {
      if (isEmpty(row[c])) continue;
      filled += 1;
      if (isHeaderEvidence(cells, r, c, years)) evidence += 1;
    }
    if (filled >= 2 && evidence * 2 > filled) {
      from = r;
      break;
    }
  }
  // 머리글처럼 보이는 줄이 없으면 첫 줄을 쓴다
  if (from < 0) return { from: 0, to: 0 };

  // 가로 병합이 있으면 그 아래 줄이 하위 머리글이다(위 조건을 만족할 때만). 최대 3줄.
  let to = from;
  while (
    to - from + 1 < MAX_HEADER_ROWS &&
    to < last &&
    horizontalMerges(to, merges).length > 0 &&
    isSubHeaderRow(cells, to, merges)
  ) {
    to += 1;
  }
  return { from, to };
}

export function columnNames(
  cells: Cell[][],
  merges: TableMerge[],
  header: { from: number; to: number }
): string[] {
  // 행이 많을 수 있다 — Math.max(...배열)은 인자 수 상한에 걸려 던진다
  let width = 0;
  for (const r of cells) if (r.length > width) width = r.length;
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

/**
 * 캡션은 파일에서 온 글이고 표 보기·요약·개요에 매번 실린다 — 20만 자 한 칸이나 제목 블록 수천 개가 이어진 캡션이
 * 그대로 실리면 크기를 파일이 정한다. 글자(코드 포인트) 단위로 잘라 '…'을 붙인다.
 */
function capCaption(caption: string): string {
  const chars = Array.from(caption);
  return chars.length > MAX_CAPTION_CHARS ? `${chars.slice(0, MAX_CAPTION_CHARS).join('')}…` : caption;
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
  if (caption) table.caption = capCaption(caption);
  if (truncated) table.truncated = truncated;
  return table;
}
