// src/lib/work/workflows/currentize/numbers.ts
// 현행화 — 올해 수치 맞추기. 순수 함수(파일·DB·AI를 모른다).
// ① 작년 표의 행 머리를 올해 자료(엑셀·CSV 표)의 행 머리와 맞춰 올해 값을 찾는다.
// ② 본문 줄글의 수치는 바꾸지 않는다 — 올해 자료에 없는 수치가 있으면 확인을 요청한다.
// 원칙: 그럴듯하지만 틀린 값을 넣지 않는다. 헷갈리면 null(= 표 쪽에서 needs_check).
import type { Cell, ExtractedTable } from '@/lib/attachments/types';
import { normalizeName, roundValue, squash } from '@/lib/table-engine/combine';
import { parseNumber } from '@/lib/table-engine/number';
import { unitMagnitude } from '@/lib/table-engine/unit-names';
import { columnUnitInfo, isKeyLikeName } from '@/lib/table-engine/units';
import type { Finding } from './classify';
import type { Segment } from './segments';
import { headerYear } from './tables';

/** 합계 낱말 행은 값이 아니라 합이라 맞추지 않는다 */
const TOTAL_LABEL = /^(합계|소계|총계|총합계|계)$/;
const NUMBER_TOLERANCE = 1e-9;

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
  for (const row of table.cells) n = Math.max(n, row.length);
  return n;
}

function bodyRows(table: ExtractedTable): number[] {
  const rows: number[] = [];
  for (let r = table.header.to + 1; r < table.cells.length; r++) rows.push(r);
  return rows;
}

function columnCells(table: ExtractedTable, col: number): Cell[] {
  return bodyRows(table).map((r) => table.cells[r]?.[col] ?? null);
}

/** 행 머리: 첫 숫자 칸 앞의, 비어 있지 않은 첫 글자 칸. 없으면 null */
function rowLabel(row: Cell[]): string | null {
  for (const cell of row) {
    if (cell === null || cell === undefined) continue;
    if (parseNumber(cell).kind === 'number') return null;
    const text = String(cell);
    if (text.trim() !== '') return text;
  }
  return null;
}

/** 값이 숫자로 읽히는 칸이 하나라도 있는 열 */
function hasNumbers(table: ExtractedTable, col: number): boolean {
  return columnCells(table, col).some((c) => parseNumber(c).kind === 'number');
}

/** 올해 값을 담은 열 하나. 정할 수 없으면 null(그 표는 쓰지 않는다) */
function pickDataColumn(table: ExtractedTable, year: number | null): number | null {
  const n = columnCount(table);
  if (year !== null) {
    const yearCols: number[] = [];
    for (let col = 0; col < n; col++) {
      if (headerYear(columnName(table, col)) === year && hasNumbers(table, col)) yearCols.push(col);
    }
    if (yearCols.length === 1) return yearCols[0];
    if (yearCols.length > 1) return null;
  }
  for (let col = 0; col < n; col++) {
    if (isKeyLikeName(columnName(table, col))) continue;
    if (hasNumbers(table, col)) return col;
  }
  return null;
}

interface DataEntry {
  label: string;
  value: number | null;
  table: ExtractedTable;
  unit: string | null;
}

/**
 * 작년 표의 각 데이터 행에 대해 올해 값(작년 표의 당해 열과 같은 단위)을 찾는다.
 * 행 머리는 normalizeName이 같은 행, 없으면 squash가 같은 행. 둘 이상이면 null. 합계 행은 null.
 */
export function matchRowValues(
  priorTable: ExtractedTable,
  dataTables: ExtractedTable[],
  curColLabel: string,
): { values: Map<number, number | null>; warnings: string[] } {
  const values = new Map<number, number | null>();
  const warnings: string[] = [];
  const rows = bodyRows(priorTable);
  for (const r of rows) values.set(r, null);

  // 작년 표의 당해 열과 그 단위
  const wanted = normalizeName(curColLabel);
  let curCol = -1;
  for (let col = 0; col < columnCount(priorTable); col++) {
    if (normalizeName(columnName(priorTable, col)) === wanted) {
      curCol = col;
      break;
    }
  }
  if (curCol < 0) {
    warnings.push(`작년 표 ${priorTable.id}에서 열 "${curColLabel}"을 찾지 못했습니다`);
    return { values, warnings };
  }
  const priorUnit =
    columnUnitInfo({
      columnName: columnName(priorTable, curCol),
      cells: columnCells(priorTable, curCol),
      caption: priorTable.caption,
    })?.unit ?? null;

  const lastYear = headerYear(curColLabel);
  const thisYear = lastYear === null ? null : lastYear + 1;

  // 올해 자료의 (행 머리, 값) 목록 — 모든 표를 한 목록에
  const entries: DataEntry[] = [];
  for (const table of dataTables) {
    const col = pickDataColumn(table, thisYear);
    if (col === null) {
      warnings.push(`올해 자료 표 ${table.id}에서 올해 값 열을 하나로 정하지 못해 쓰지 않았습니다`);
      continue;
    }
    const unit =
      columnUnitInfo({ columnName: columnName(table, col), cells: columnCells(table, col), caption: table.caption })
        ?.unit ?? null;
    for (const r of bodyRows(table)) {
      const row = table.cells[r] ?? [];
      const label = rowLabel(row);
      if (label === null) continue;
      const p = parseNumber(row[col] ?? null);
      // 괄호로 적힌 숫자는 음수인지 알 수 없어 값으로 쓰지 않는다
      const value = p.kind === 'number' && !p.parenthesized ? p.value : null;
      entries.push({ label, value, table, unit });
    }
  }

  const warned = new Set<string>();
  const warn = (message: string, table: ExtractedTable) => {
    const text = `${message}: 표 ${table.id}`;
    if (warned.has(text)) return;
    warned.add(text);
    warnings.push(text);
  };

  const findOne = (key: (s: string) => string, label: string): DataEntry | 'many' | null => {
    const hits = entries.filter((e) => key(e.label) === key(label));
    if (hits.length === 0) return null;
    return hits.length === 1 ? hits[0] : 'many';
  };

  for (const r of rows) {
    const label = rowLabel(priorTable.cells[r] ?? []);
    if (label === null || TOTAL_LABEL.test(squash(label))) continue;
    let hit = findOne(normalizeName, label);
    if (hit === null) hit = findOne(squash, label);
    if (hit === null || hit === 'many' || hit.value === null) continue;
    values.set(r, convertUnit(hit, priorUnit, warn));
  }
  return { values, warnings };
}

/** 올해 값을 작년 표 단위로. 차원이 다르면 null, 한쪽 단위만 알면 그대로 + 경고 */
function convertUnit(
  hit: DataEntry,
  priorUnit: string | null,
  warn: (message: string, table: ExtractedTable) => void,
): number | null {
  const value = hit.value as number;
  if (priorUnit === null && hit.unit === null) return value;
  if (priorUnit === null) {
    warn('작년 표의 단위를 알 수 없어 그대로 넣었습니다', hit.table);
    return value;
  }
  if (hit.unit === null) {
    warn('올해 자료의 단위를 알 수 없어 그대로 넣었습니다', hit.table);
    return value;
  }
  if (priorUnit === hit.unit) return value;
  const from = unitMagnitude(hit.unit);
  const to = unitMagnitude(priorUnit);
  if (!from || !to || from.base !== to.base) return null;
  const shift = from.exponent - to.exponent;
  return roundValue(shift >= 0 ? value * 10 ** shift : value / 10 ** -shift);
}

/**
 * 본문 조각의 수치가 모두 올해 자료·표 결과에 있으면 ok, 하나라도 없으면 needs_check.
 * 본문 수치는 프로그램도 모델도 바꾸지 않는다 — 표만 바뀌고 본문에 옛 수치가 남는 것을 사람이 보게 한다.
 * 크기(절댓값)로 비교한다 — 증감은 부호 대신 '감소'로 풀어 쓰기도 한다.
 */
export function proseNumberStatus(
  _segment: Segment,
  findings: Finding[],
  knownNumbers: Set<number>,
): 'ok' | 'needs_check' {
  const known = [...knownNumbers].filter(Number.isFinite).map(Math.abs);
  for (const f of findings) {
    if (f.kind !== 'number') continue;
    const p = parseNumber(f.text);
    // 읽지 못한 수치는 확인할 수 없으니 사람이 본다
    if (p.kind !== 'number') return 'needs_check';
    const v = Math.abs(p.value);
    const tol = NUMBER_TOLERANCE * Math.max(1, v);
    if (!known.some((k) => Math.abs(k - v) <= tol)) return 'needs_check';
  }
  return 'ok';
}
