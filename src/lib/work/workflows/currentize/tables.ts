// src/lib/work/workflows/currentize/tables.ts
// 현행화 — 표의 열 밀기. 순수 함수(파일·DB·AI를 모른다).
// 공공기관 표는 흔히 `구분 | 전년도 | 당해 | 증감 | 증감률`이다. 현행화하면
// 옛 '당해' 값이 '전년도' 칸으로 가고, '당해'는 새 값을 받고, 증감·증감률은 다시 계산한다.
// 새 값을 찾는 일(Task 7)은 여기서 하지 않는다 — newValues로 받기만 한다.
import type { Cell, ExtractedTable } from '@/lib/attachments/types';
import { roundValue } from '@/lib/table-engine/combine';
import { parseNumber } from '@/lib/table-engine/number';

export interface ColumnPlan {
  prevCol: number;
  curCol: number;
  diffCols: { col: number; kind: 'diff' | 'rate' }[];
}

export interface ShiftedCell {
  row: number;
  col: number;
  before: string;
  after: string | null;
  status: 'changed' | 'needs_check';
}

const RATE_NAME = /증감률|증감율|증가율|비율/;
const DIFF_NAME = /증감|증가|차이|대비/;

/** 4자리 연도(1900~2100). 앞뒤에 숫자가 이어지면 연도가 아니다 */
const FOUR_DIGIT_YEAR = /(?<!\d)(19\d{2}|20\d{2}|2100)(?!\d)/g;
/** 아포스트로피 두 자리 연도: '25 ’25 ‘25 */
const SHORT_YEAR = /['’‘]\s?(\d{2})(?!\d)/g;

/**
 * 머리글 글에서 연도 하나를 뽑는다. 연도가 정확히 하나일 때만 값을 낸다.
 * (3월·1분기는 연도가 아니고, '2025년 대비 2024년'처럼 둘이 들면 어느 쪽인지 몰라 null)
 */
export function headerYear(cell: Cell | undefined): number | null {
  if (cell === null || cell === undefined) return null;
  const text = String(cell);
  const years: number[] = [];
  for (const m of text.matchAll(FOUR_DIGIT_YEAR)) years.push(Number(m[1]));
  for (const m of text.matchAll(SHORT_YEAR)) years.push(2000 + Number(m[1]));
  return years.length === 1 ? years[0] : null;
}

/** 열 머리글 글: columns가 있으면 그것, 없으면 머리글 칸을 이어 붙인다 */
function columnName(table: ExtractedTable, col: number): string {
  const named = table.columns[col];
  if (typeof named === 'string' && named.trim() !== '') return named;
  const parts: string[] = [];
  for (let r = table.header.from; r <= table.header.to; r++) {
    const c = table.cells[r]?.[col];
    if (c !== null && c !== undefined && String(c).trim() !== '') parts.push(String(c).trim());
  }
  return parts.join(' / ');
}

function columnCount(table: ExtractedTable): number {
  let n = table.columns.length;
  for (let r = table.header.from; r <= table.header.to; r++) n = Math.max(n, table.cells[r]?.length ?? 0);
  return n;
}

/** 머리글 연도꼴 둘(toYear−2, toYear−1)과 증감·증감률 열을 찾는다. 짝이 안 서면 null */
export function planColumnShift(table: ExtractedTable, toYear: number): ColumnPlan | null {
  const diffCols: ColumnPlan['diffCols'] = [];
  const yearCols = new Map<number, number[]>();

  for (let col = 0; col < columnCount(table); col++) {
    const name = columnName(table, col);
    // 증감 열이 이름에 연도를 품을 수 있다('2025 대비 증감') — 연도 열로 세지 않는다
    if (RATE_NAME.test(name)) {
      diffCols.push({ col, kind: 'rate' });
      continue;
    }
    if (DIFF_NAME.test(name)) {
      diffCols.push({ col, kind: 'diff' });
      continue;
    }
    const y = headerYear(name);
    if (y !== null) yearCols.set(y, [...(yearCols.get(y) ?? []), col]);
  }

  const prev = yearCols.get(toYear - 2);
  const cur = yearCols.get(toYear - 1);
  // 같은 연도 열이 둘(예산·결산)이면 어느 쪽이 '당해'인지 몰라 만들지 않는다
  if (!prev || !cur || prev.length !== 1 || cur.length !== 1) return null;
  return { prevCol: prev[0], curCol: cur[0], diffCols };
}

/** 병합에 덮인 칸(주인이 아닌 좌표) 집합 */
function coveredCells(table: ExtractedTable): Set<string> {
  const covered = new Set<string>();
  for (const m of table.merges) {
    for (let r = m.row; r < m.row + m.rows; r++) {
      for (let c = m.col; c < m.col + m.cols; c++) {
        if (r === m.row && c === m.col) continue;
        covered.add(`${r},${c}`);
      }
    }
  }
  return covered;
}

/** 칸의 숫자 값. 비었거나 읽지 못하면 null — 0으로 치지 않는다 */
function numberOf(cell: Cell | undefined): number | null {
  const p = parseNumber(cell ?? null);
  return p.kind === 'number' ? p.value : null;
}

function textOf(cell: Cell | undefined): string {
  return cell === null || cell === undefined ? '' : String(cell);
}

/** 천 단위 쉼표 + 소수 자릿수는 최대 maxFrac. 음의 0은 0 */
function formatNumber(x: number, maxFrac: number): string {
  const v = Object.is(x, -0) ? 0 : x;
  return v.toLocaleString('en-US', { maximumFractionDigits: maxFrac, useGrouping: true });
}

/**
 * 계획대로 열을 민다. 자료 행(머리글 아래)마다 전년도 ← 옛 당해, 당해 ← 새 값, 증감·증감률 재계산.
 * 병합에 덮인 칸은 결과에 넣지 않는다 — 주인 칸만 바꾼다.
 */
export function shiftColumns(
  table: ExtractedTable,
  plan: ColumnPlan,
  newValues: Map<number, number | null>,
): { cells: ShiftedCell[] } {
  const covered = coveredCells(table);
  const out: ShiftedCell[] = [];
  const isCovered = (row: number, col: number) => covered.has(`${row},${col}`);

  for (let row = table.header.to + 1; row < table.cells.length; row++) {
    const line = table.cells[row] ?? [];
    const oldCur = line[plan.curCol];
    const prev = numberOf(oldCur);
    const nv = newValues.get(row);
    const cur = typeof nv === 'number' && Number.isFinite(nv) ? roundValue(nv) : null;

    // 1) 전년도 ← 옛 당해(글 그대로). 당해 칸이 병합에 덮인 행은 값의 주인이 윗 행이라 옮길 수 없다
    if (!isCovered(row, plan.prevCol)) {
      const curCovered = isCovered(row, plan.curCol);
      out.push({
        row,
        col: plan.prevCol,
        before: textOf(line[plan.prevCol]),
        after: curCovered ? null : textOf(oldCur),
        status: curCovered ? 'needs_check' : 'changed',
      });
    }

    // 2) 당해 ← 새 값
    if (!isCovered(row, plan.curCol)) {
      out.push({
        row,
        col: plan.curCol,
        before: textOf(oldCur),
        after: cur === null ? null : formatNumber(cur, 10),
        status: cur === null ? 'needs_check' : 'changed',
      });
    }

    // 3) 증감·증감률 다시 계산 — 값이 모자라면 비워 두고 확인 요청
    for (const { col, kind } of plan.diffCols) {
      if (isCovered(row, col)) continue;
      let after: string | null = null;
      if (cur !== null && prev !== null) {
        const diff = roundValue(cur - prev);
        if (kind === 'diff') {
          after = formatNumber(diff, 10);
        } else if (prev > 0) {
          // 기준(전년도)이 0이면 나눌 수 없고, 음수면 증감률의 부호가 뒤집혀 모호하다
          after = formatNumber(Number(roundValue((diff / prev) * 100).toFixed(2)), 2);
        }
      }
      out.push({
        row,
        col,
        before: textOf(line[col]),
        after,
        status: after === null ? 'needs_check' : 'changed',
      });
    }
  }
  return { cells: out };
}
