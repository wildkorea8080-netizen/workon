/**
 * 표 합치기. 단계: 원천 준비 → 쌓기 → [거르기 → 묶기·집계 → 정렬 → 합계 행(Task 3)].
 * 원칙은 "그럴듯하지만 틀린 합계를 내지 않는다" — 의심스러우면 값을 빼고 근거에 남기거나 실패한다.
 * 이미 있는 합계 행을 다시 더하는 것, 단위가 다른 열을 섞는 것, 읽지 못한 칸을 0으로 치는 것이 막을 대상이다.
 */
import { columnNames } from '@/lib/attachments/header';
import type { Cell, ExtractedTable } from '@/lib/attachments/types';
import { parseNumber, type Parsed } from './number';
import { unitMagnitude, unitWithMagnitude } from './unit-names';
import { columnUnitInfo, nameDimension, normalizeUnit, type UnitSource } from './units';
import type {
  CombineResult,
  CombineSpec,
  Lineage,
  ResultColumn,
  ResultValue,
  SourceSpec,
  SourceTable,
} from './types';

/** 지시가 틀렸을 때 던져 입구가 { ok:false }로 바꾼다 — 단계마다 실패를 실어 나르지 않으려고 */
class CombineError extends Error {}

function fail(message: string): never {
  throw new CombineError(message);
}

/** 원천 안에 이미 있는 합계 행 — 다시 더하면 두 배가 된다. 누계는 합계가 아니라 값일 수 있어 기본에서 뺀다 */
const TOTAL_LABELS = new Set(['합계', '소계', '계', '총계', '총합계', 'total', 'subtotal']);
const SOURCE_COLUMN = '출처';
/** 머리글이 비어 columnNames가 붙인 이름 */
const AUTO_NAME = /^열 \d+$/;
/** 근거에 남기는 행 글 상한 — 파일에서 온 글이 근거 크기를 정하지 않게 */
const MAX_ROW_TEXT = 200;
/** 열 이름 끝의 단위 괄호: '예산(천원)'·'예산 (단위: 원)' */
const TRAILING_UNIT = /^(.*?)\s*[(（[]\s*(?:단위\s*[:：]?\s*)?([^()（）[\]]+?)\s*[)）\]]\s*$/s;

/** 공백(전각 포함)을 모두 지운다 — '소 계'와 '소계'를 같게 */
function squash(text: string): string {
  return text.replace(/\s+/g, '');
}

/** 합계 표기 다듬기: 공백·앞 ※*·[ ]·끝 괄호('합계(A)'·'소계(1)')를 떼고 소문자로 */
function totalLabel(text: string): string {
  let s = squash(text).replace(/^[※*]+/, '');
  for (let i = 0; i < 3; i += 1) {
    const before = s;
    s = s
      .replace(/^[[［【〔]+/, '')
      .replace(/[\]］】〕]+$/, '')
      .replace(/[(（][^()（）]*[)）]$/, '');
    if (s === before) break;
  }
  return s.toLowerCase();
}

function isBlank(cell: Cell | undefined): boolean {
  return cell === null || cell === undefined || (typeof cell === 'string' && cell.trim() === '');
}

/** 곱셈 오차(1234 × 0.001 = 1.2340000000000002)가 결과·엑셀에 나오지 않게 소수 10자리에서 반올림 */
export function roundValue(x: number): number {
  return Number.isInteger(x) ? x : Number(x.toFixed(10));
}

/** 단위 괄호를 뗀 이름과 그 단위. 단위가 아닌 괄호('예산(국비)')는 이름의 일부로 둔다 */
function splitUnitName(name: string): { base: string; unit: string | null } {
  const m = TRAILING_UNIT.exec(name);
  if (m && m[1].trim() !== '') {
    const unit = normalizeUnit(m[2]);
    if (unit) return { base: m[1].trim(), unit };
  }
  return { base: name, unit: null };
}

function rowText(cells: Cell[]): string {
  const text = cells.filter((c) => !isBlank(c)).map((c) => String(c).trim()).join(' | ');
  const chars = Array.from(text);
  return chars.length > MAX_ROW_TEXT ? `${chars.slice(0, MAX_ROW_TEXT).join('')}…` : text;
}

function missingColumn(label: string, name: string, existing: string[]): never {
  fail(`${label}에 "${name}" 열이 없습니다. 있는 열: ${existing.join(', ')}`);
}

interface PreparedColumn {
  /** 원천의 원래 열 이름 — 근거의 위치 표기에 쓴다 */
  original: string;
  /** 이름 바꾼 뒤 */
  name: string;
  /** 단위 괄호를 뗀 이름 */
  base: string;
  /** 쌓을 때 맞추는 이름 — base 또는 name(쌓기 단계가 정한다) */
  key: string;
  /** cells의 열 번호 */
  index: number;
  unit: string | null;
  unitSource: UnitSource | null;
  scale?: number;
}

interface PreparedRow {
  /** 원본 cells의 1부터 번호 */
  row: number;
  /** 집계용: 세로 병합 글자만 아래로 채움(숫자는 주인 칸에만) */
  values: Cell[];
  /** 키용: 세로 병합은 숫자·글자 모두 아래로 채움 — 병합된 연도 아래 행도 그 연도로 묶이게 */
  keys: Cell[];
}

interface PreparedSource {
  label: string;
  file: string;
  fileName: string;
  table: ExtractedTable;
  headerRows: [number, number];
  columns: PreparedColumn[];
  rows: PreparedRow[];
  rowsIn: number;
}

/**
 * 쌓은 행 한 줄. Task 3의 거르기·묶기·정렬은 keys를, 집계·합계 행은 values를 쓴다.
 * source = lineage.sources의 번호, row = 원본 cells의 1부터 번호
 */
export interface StackedRow {
  source: number;
  row: number;
  values: ResultValue[];
  keys: ResultValue[];
}

interface Stacked {
  columns: ResultColumn[];
  rows: StackedRow[];
  lineage: Lineage;
}

export type StackResult = ({ ok: true } & Stacked) | { ok: false; error: string };

function emptyLineage(): Lineage {
  return {
    sources: [],
    renamed: [],
    scaled: [],
    skippedRows: [],
    unreadable: [],
    mergedNumbers: [],
    onlyIn: [],
    unitWarnings: [],
    parenthesizedNegatives: [],
    columnWarnings: [],
    similarKeys: [],
    rowCounts: { stacked: 0, filtered: 0, result: 0 },
    truncated: false,
  };
}

// ── 1단계: 원천 준비 ─────────────────────────────────────────────

/** 일련번호 열 이름. 값이 1..n이어도 이름이 이렇지 않으면 일련번호로 보지 않는다 — '예산'이 1·2·3일 수도 있다 */
const SERIAL_NAME = /^(연번|순번|번호|일련번호|no\.?)$/i;
/** 키성 숫자 열 이름: 연도·코드·번호류 */
const KEY_NAME = /연도|년도|년|코드|번호|순번|연번|(^|[^a-z])id([^a-z]|$)/i;

/**
 * 숫자이지만 측정값이 아니라 행을 가리키는 열(일련번호·연도·코드).
 * 이름에 숫자가 든 열('2025년', '2024년 예산')은 연도별 측정 열이라 이름 규칙에서 뺀다
 */
function isKeyColumn(name: string, rows: Cell[][], c: number): boolean {
  const compact = squash(name);
  if (SERIAL_NAME.test(compact)) return true;
  if (!/\d/.test(compact) && KEY_NAME.test(compact)) return true;
  let numbers = 0;
  for (const row of rows) {
    const p = parseNumber(row[c]);
    if (p.kind !== 'number') continue;
    if (!Number.isInteger(p.value) || p.value < 1900 || p.value > 2100) return false;
    numbers += 1;
  }
  return numbers > 0;
}

/**
 * 합계 표기를 찾을 라벨 열 = 첫 측정 열 왼쪽의 글자 열. 키성 숫자 열(연도·코드·일련번호)은 측정 열이 아니라 건너뛴다 —
 * 맨 앞이 연도면 라벨 열이 비어 [2025, 합계, 300]이 두 번 더해진다.
 * 측정 열 사이·오른쪽(비고 등)의 '계(추정)'·'소계(포함)'은 데이터라 보지 않는다 — 보면 데이터 행이 지워진다
 */
function labelColumns(rows: Cell[][], width: number, names: string[]): number[] {
  const found: number[] = [];
  for (let c = 0; c < width; c += 1) {
    let nonEmpty = 0;
    let numbers = 0;
    for (const row of rows) {
      const p = parseNumber(row[c]);
      if (p.kind === 'empty') continue;
      nonEmpty += 1;
      if (p.kind === 'number') numbers += 1;
    }
    if (nonEmpty === 0) continue;
    if (numbers * 2 > nonEmpty) {
      if (isKeyColumn(names[c] ?? '', rows, c)) continue;
      break;
    }
    found.push(c);
  }
  return found;
}

function prepareSource(source: SourceTable, spec: SourceSpec, lineage: Lineage): PreparedSource {
  const { table } = source;
  const label = `${spec.file}/${spec.table}`;
  const cells = table.cells;

  let header = table.header;
  let names = table.columns;
  if (spec.header_rows !== undefined) {
    const hr = spec.header_rows;
    const valid =
      Array.isArray(hr) &&
      hr.length === 2 &&
      hr.every((n) => Number.isInteger(n)) &&
      hr[0] >= 1 &&
      hr[0] <= hr[1] &&
      hr[1] <= cells.length;
    if (!valid) {
      fail(`${label}의 머리글 행(header_rows) 지정이 맞지 않습니다. 1부터 ${cells.length} 사이의 [시작, 끝]으로 주세요.`);
    }
    header = { from: hr[0] - 1, to: hr[1] - 1 };
    names = columnNames(cells, table.merges, header);
  }
  const width = names.length;
  const bodyStart = header.to + 1;

  // 판정(빈 행·합계 행)은 원래 칸으로 한다
  const original: Cell[][] = [];
  for (let r = bodyStart; r < cells.length; r += 1) {
    original.push(Array.from({ length: width }, (_, c) => cells[r]?.[c] ?? null));
  }
  const values = original.map((row) => [...row]);
  const keys = original.map((row) => [...row]);
  /** `본문행,열` → 병합이 끝나는 원본 행(1부터) */
  const mergedNumberEnd = new Map<string, number>();
  for (const m of table.merges) {
    // 머리글에서 시작한 병합은 이미 열 이름에 들었다
    if (m.rows < 2 || m.row < bodyStart || m.col >= width) continue;
    const owner = cells[m.row]?.[m.col] ?? null;
    if (isBlank(owner)) continue;
    const at = m.row - bodyStart;
    const end = Math.min(at + m.rows, original.length);
    // 숫자는 집계용에서 주인 칸에만 — 아래로 채우면 같은 금액이 병합 행 수만큼 더해진다
    const isNumber = parseNumber(owner).kind === 'number';
    if (isNumber) mergedNumberEnd.set(`${at},${m.col}`, bodyStart + end);
    for (let r = at + 1; r < end; r += 1) {
      keys[r][m.col] = owner;
      if (!isNumber) values[r][m.col] = owner;
    }
  }

  const labels = labelColumns(original, width, names);
  const skipWords = new Set(
    (spec.skip_rows_matching ?? []).map((w) => squash(String(w)).toLowerCase()).filter((w) => w !== '')
  );
  const labelReason = (c: Cell | undefined): string | null => {
    if (typeof c !== 'string' || c.trim() === '') return null;
    if (TOTAL_LABELS.has(totalLabel(c))) return '합계 행';
    if (skipWords.has(squash(c).toLowerCase()) || skipWords.has(totalLabel(c))) return '지정한 글';
    return null;
  };
  // 여러 행에 병합된 합계 라벨: 원래 칸에는 첫 행에만 글이 있어, 아래 행(결산·시비 등)이 남아 두 번 더해진다
  const coveredReason = new Map<number, string>();
  for (const m of table.merges) {
    if (m.rows < 2 || m.row < bodyStart || m.col >= width) continue;
    const at = m.row - bodyStart;
    const owner = original[at]?.[m.col];
    const isFirst = original[at]?.findIndex((c) => !isBlank(c)) === m.col;
    if (!labels.includes(m.col) && !isFirst) continue;
    const reason = labelReason(owner);
    if (!reason) continue;
    for (let r = at; r < Math.min(at + m.rows, original.length); r += 1) {
      // 병합 안인데 그 칸에 제 글이 있으면 병합 정보가 어긋난 것 — 칸의 글을 믿고 거기서 멈춘다(데이터 행을 지우지 않게)
      if (r > at && !isBlank(original[r][m.col])) break;
      if (!coveredReason.has(r)) coveredReason.set(r, reason);
    }
  }
  const rows: PreparedRow[] = [];
  const bodyIndexes: number[] = [];
  let rowsIn = 0;
  original.forEach((orig, i) => {
    if (orig.every(isBlank)) return; // 빈 행은 근거에 남기지 않는다
    rowsIn += 1;
    const rowNo = bodyStart + i + 1;
    // 첫 비지 않은 칸 + 라벨 열. 병합된 '총무과' 아래 '소계'는 원래 칸에서 첫 칸이 '소계'다
    const reasons = [orig.find((c) => !isBlank(c)), ...labels.map((c) => orig[c])].map(labelReason);
    const reason = reasons.includes('합계 행')
      ? '합계 행'
      : reasons.includes('지정한 글')
        ? '지정한 글'
        : (coveredReason.get(i) ?? null);
    if (reason) {
      lineage.skippedRows.push({ file: spec.file, table: table.id, row: rowNo, reason, text: rowText(orig) });
      return;
    }
    rows.push({ row: rowNo, values: values[i], keys: keys[i] });
    bodyIndexes.push(i);
  });

  // 머리글도 값도 없는 여백 열은 버린다 — 결과에 빈 열과 onlyIn 경고만 남긴다
  const referenced = new Set([...Object.keys(spec.rename ?? {}), ...Object.keys(spec.scale ?? {})]);
  const columns: PreparedColumn[] = names
    .map((name, index) => ({
      original: name,
      name,
      base: name,
      key: name,
      index,
      unit: null as string | null,
      unitSource: null as UnitSource | null,
    }))
    .filter(
      (c) => !(AUTO_NAME.test(c.original) && !referenced.has(c.original) && rows.every((r) => isBlank(r.values[c.index])))
    );

  for (const [from, rawTo] of Object.entries(spec.rename ?? {})) {
    const col = columns.find((c) => c.original === from);
    if (!col) missingColumn(label, from, columns.map((c) => c.original));
    const to = String(rawTo ?? '').trim();
    if (to === '') fail(`${label}의 "${from}" 열을 바꿀 이름이 비어 있습니다.`);
    if (to === from) continue;
    col.name = to;
    lineage.renamed.push({ file: spec.file, from, to });
  }
  const seen = new Set<string>();
  for (const c of columns) {
    if (seen.has(c.name)) fail(`${label}에서 이름을 바꾸면 "${c.name}" 열이 둘이 됩니다.`);
    seen.add(c.name);
    c.base = splitUnitName(c.name).base;
    c.key = c.name;
    const info = columnUnitInfo({
      columnName: c.original,
      caption: table.caption,
      cells: rows.map((r) => r.values[c.index]),
    });
    c.unit = info?.unit ?? null;
    c.unitSource = info?.source ?? null;
  }

  for (const [name, factor] of Object.entries(spec.scale ?? {})) {
    const col =
      columns.find((c) => c.name === name) ??
      columns.find((c) => c.original === name) ??
      columns.find((c) => c.base === name);
    if (!col) missingColumn(label, name, columns.map((c) => c.name));
    if (typeof factor !== 'number' || !Number.isFinite(factor) || factor <= 0) {
      fail(`${label}의 "${name}" scale은 0보다 큰 숫자여야 합니다.`);
    }
    col.scale = factor;
  }

  // 세로 병합 숫자는 쓰인 행에서만 근거에 남긴다
  rows.forEach((row, k) => {
    for (const c of columns) {
      const end = mergedNumberEnd.get(`${bodyIndexes[k]},${c.index}`);
      if (end !== undefined) {
        lineage.mergedNumbers.push({ file: spec.file, table: table.id, row: row.row, rowEnd: end, column: c.original });
      }
    }
  });

  return {
    label,
    file: spec.file,
    fileName: source.fileName,
    table,
    headerRows: [header.from + 1, header.to + 1],
    columns,
    rows,
    rowsIn,
  };
}

// ── 2단계: 쌓기 ───────────────────────────────────────────────

interface Slot {
  src: number;
  col: PreparedColumn;
  parsed: Parsed[];
}

interface ColumnGroup {
  key: string;
  firstName: string;
  slots: Slot[];
}

/**
 * 단위 괄호를 뗀 이름으로 맞출지 정한다. 같은 차원(크기만 다름: 원·천원)이거나 단위 없는 쪽과 만날 때만 뗀다 —
 * '인원(명)'과 '인원(%)'을 한 열에 넣으면 단위 충돌로 거부되거나, 더 나쁘게는 뜻이 다른 값이 섞인다.
 * 한 원천 안에서 뗀 이름이 겹쳐도('예산(천원)'·'예산(원)') 떼지 않는다
 */
function assignKeys(prepared: PreparedSource[]): void {
  const byBase = new Map<string, { src: number; col: PreparedColumn }[]>();
  prepared.forEach((p, src) => {
    for (const col of p.columns) {
      const list = byBase.get(col.base) ?? [];
      list.push({ src, col });
      byBase.set(col.base, list);
    }
  });
  for (const members of byBase.values()) {
    const sources = new Set(members.map((m) => m.src));
    const dimensions = new Set<string>();
    for (const m of members) {
      const u = splitUnitName(m.col.name).unit;
      if (u) dimensions.add(unitMagnitude(u)?.base ?? u);
    }
    const together = sources.size === members.length && dimensions.size <= 1;
    for (const m of members) m.col.key = together ? m.col.base : m.col.name;
  }
}

/** 10의 d제곱을 글로 — 0.1 ** 8이 1.0000000000000002e-8로 나오지 않게 */
function powerOfTen(d: number): string {
  return d >= 0 ? `1${'0'.repeat(d)}` : `0.${'0'.repeat(-d - 1)}1`;
}

/** scale을 곱한 뒤의 단위('원' × 0.001 → '천원'). 10의 거듭제곱이 아니거나 그런 단위가 없으면 null */
function convertedUnit(unit: string, factor: number): string | null {
  const mag = unitMagnitude(unit);
  if (!mag) return null;
  const exponent = mag.exponent - Math.log10(factor);
  const rounded = Math.round(exponent);
  if (Math.abs(exponent - rounded) > 1e-9) return null;
  return unitWithMagnitude(mag.base, rounded);
}

function unitConflict(group: ColumnGroup, known: Slot[], prepared: PreparedSource[]): never {
  // 캡션에서 온 단위는 표 전체에 쓰인 글이라 이 열 것이 아닐 수 있다 — 사람이 확인할 수 있게 출처를 붙인다
  const list = known
    .map((s) => `${prepared[s.src].label}=${s.col.unit}${s.col.unitSource === 'caption' ? '(표 위 글)' : ''}`)
    .join(', ');
  const target = known[0].col.unit as string;
  const targetMag = unitMagnitude(target);
  const other = known.find((s) => {
    const mag = unitMagnitude(s.col.unit as string);
    return s.col.unit !== target && mag && targetMag && mag.base === targetMag.base;
  });
  const head = `열 "${group.key}"의 단위가 원천마다 다릅니다: ${list}.`;
  if (!other || !targetMag) fail(`${head} 서로 바꿀 수 없는 단위라 같은 열인지 확인하세요.`);
  // 숫자 예시는 돈 열에서만 — 사람 수·건수에 배율을 권하면 그대로 따라 틀린 값이 된다
  const money = targetMag.base === '원' && nameDimension(group.key) === '돈';
  if (!money) fail(`${head} scale로 맞춘 뒤 다시 계산하세요.`);
  const factor = powerOfTen((unitMagnitude(other.col.unit as string)?.exponent ?? 0) - targetMag.exponent);
  fail(`${head} scale로 맞춘 뒤 다시 계산하세요(예: ${prepared[other.src].file}의 "${group.key}"에 ${factor}).`);
}

/** %·%p·배 열에서 분수 ↔ 백분율 바꿈(×100·×0.01)은 단위 이름이 그대로라 따로 허용한다 */
const RATIO_UNITS = new Set(['%', '%p', '배']);

/**
 * 숫자 열의 단위. 서로 다르면 실패. scale은 단위 크기로 검사한다 — 단위를 아는 열에 준 배율이 아는 단위로
 * 떨어지지 않으면(원 ×1000, 천원 ×1.5) 비교할 원천이 없어도 실패. 환산된 단위는 아는 단위로 친다
 */
function resolveUnit(group: ColumnGroup, prepared: PreparedSource[], lineage: Lineage): string | null {
  const unscaled = group.slots.filter((s) => s.col.scale === undefined && s.col.unit !== null);
  if (new Set(unscaled.map((s) => s.col.unit)).size > 1) unitConflict(group, unscaled, prepared);
  const scaled = group.slots
    .filter((s) => s.col.scale !== undefined && s.col.unit !== null)
    .map((s) => {
      const from = s.col.unit as string;
      const factor = s.col.scale as number;
      const p = prepared[s.src];
      if (RATIO_UNITS.has(from) && (factor === 100 || factor === 0.01)) {
        lineage.unitWarnings.push(
          `열 "${group.key}": ${p.label} 값을 ×${factor} 했습니다(${factor === 100 ? '분수 → 백분율' : '백분율 → 분수'})`
        );
        return { slot: s, unit: from };
      }
      return { slot: s, unit: convertedUnit(from, factor) };
    });
  const unit = unscaled[0]?.col.unit ?? scaled.find((c) => c.unit !== null)?.unit ?? null;
  // 비교할 단위가 없어도 아는 단위로 떨어지지 않는 배율은 틀린 배율이다
  const lost = scaled.find((c) => c.unit === null);
  if (lost && !unit) {
    const { slot } = lost;
    fail(`scale 방향/크기가 단위와 맞지 않습니다 (${prepared[slot.src].file} ${slot.col.unit}×${slot.col.scale} → 맞는 단위 없음)`);
  }
  if (unit) {
    for (const c of scaled) {
      if (c.unit !== unit) {
        const { slot } = c;
        fail(`scale 방향/크기가 단위와 맞지 않습니다 (${prepared[slot.src].file} ${slot.col.unit}×${slot.col.scale} ≠ ${unit})`);
      }
    }
    for (const s of group.slots) {
      if (s.col.unit === null && s.col.scale === undefined) {
        lineage.unitWarnings.push(`열 "${group.key}": ${prepared[s.src].label}은 단위를 알 수 없습니다 — 같은 단위인지 확인하세요`);
      }
    }
  }
  // 원천 단위를 모르면 배율이 맞는지 검사할 수 없다 — 따르기만 한 배율이 틀린 값을 만들 수 있어 알린다
  for (const s of group.slots) {
    if (s.col.unit === null && s.col.scale !== undefined) {
      lineage.unitWarnings.push(
        `열 "${group.key}": ${prepared[s.src].label}은 단위를 알 수 없어 scale ×${s.col.scale}이 맞는지 확인하지 못했습니다`
      );
    }
  }
  return unit;
}

/**
 * % 열에 분수(0.85)로 적은 원천과 백분수(92)로 적은 원천이 섞이면 합·평균이 틀린다(엑셀은 % 서식 칸을 분수로 저장한다).
 * 값만으로는 확정할 수 없어 바꾸지 않고 알린다
 */
function warnFractionPercent(
  name: string,
  slots: Slot[],
  bySource: Map<number, { values: ResultValue[] }>,
  prepared: PreparedSource[],
  lineage: Lineage
): void {
  const fraction: Slot[] = [];
  let hasPercent = false;
  for (const s of slots) {
    const nums = (bySource.get(s.src)?.values ?? []).filter((v): v is number => typeof v === 'number');
    if (nums.length === 0) continue;
    if (nums.every((v) => Math.abs(v) <= 1)) fraction.push(s);
    else hasPercent = true;
  }
  if (!hasPercent) return;
  for (const s of fraction) {
    lineage.unitWarnings.push(`열 "${name}": ${prepared[s.src].label} 값이 분수(0~1)로 적힌 것 같습니다 — scale 100으로 맞추세요`);
  }
}

function stack(sources: SourceTable[], spec: CombineSpec): Stacked {
  // 원천 옵션의 근원은 spec.sources 하나다. 순서도 지시 순서
  const wanted = spec.sources ?? [];
  if (wanted.length === 0) fail('합칠 표가 없습니다.');
  const received = sources.map((s) => `${s.file}/${s.table.id}`);
  const seenSource = new Set<string>();
  const pairs = wanted.map((want) => {
    const label = `${want.file}/${want.table}`;
    // 같은 표를 두 번 쌓으면 그 표가 두 번 더해진다
    if (seenSource.has(label)) fail(`${label}을 두 번 지정했습니다`);
    seenSource.add(label);
    const found = sources.find((s) => s.file === want.file && s.table.id === want.table);
    if (!found) fail(`${label} 표를 찾지 못했습니다. 받은 표: ${received.join(', ') || '없음'}`);
    return { source: found, spec: want };
  });

  const lineage = emptyLineage();
  const prepared = pairs.map((p) => prepareSource(p.source, p.spec, lineage));
  for (const p of prepared) {
    lineage.sources.push({
      file: p.file,
      fileName: p.fileName,
      table: p.table.id,
      title: p.table.title,
      headerRows: p.headerRows,
      rowsIn: p.rowsIn,
      rowsUsed: p.rows.length,
    });
  }
  assignKeys(prepared);

  // 결과 열 = 원천 열의 합집합(처음 나온 순서)
  const groups: ColumnGroup[] = [];
  const byKey = new Map<string, ColumnGroup>();
  prepared.forEach((p, src) => {
    for (const col of p.columns) {
      let g = byKey.get(col.key);
      if (!g) {
        g = { key: col.key, firstName: col.name, slots: [] };
        byKey.set(col.key, g);
        groups.push(g);
      }
      g.slots.push({ src, col, parsed: p.rows.map((r) => parseNumber(r.values[col.index])) });
    }
  });
  if (spec.add_source_column && groups.some((g) => g.key === SOURCE_COLUMN || g.firstName === SOURCE_COLUMN)) {
    fail(`"${SOURCE_COLUMN}" 열이 이미 있습니다. rename으로 이름을 바꾼 뒤 다시 계산하세요.`);
  }

  const columns: ResultColumn[] = [];
  /** groups 순서대로, 원천 번호 → 그 원천 행들의 [집계용, 키용] 값 */
  const layers: Map<number, { values: ResultValue[]; keys: ResultValue[] }>[] = [];

  for (const g of groups) {
    // 숫자 열: 비지 않은 값의 과반이 숫자
    let nonEmpty = 0;
    let numbers = 0;
    for (const s of g.slots) {
      for (const p of s.parsed) {
        if (p.kind === 'empty') continue;
        nonEmpty += 1;
        if (p.kind === 'number') numbers += 1;
      }
    }
    const numeric = numbers * 2 > nonEmpty;

    let unit: string | null = null;
    if (numeric) {
      unit = resolveUnit(g, prepared, lineage);
    } else {
      const scaled = g.slots.find((s) => s.col.scale !== undefined);
      if (scaled) fail(`${prepared[scaled.src].label}의 "${scaled.col.name}"는 숫자 열이 아니라 scale을 쓸 수 없습니다.`);
    }

    let name = g.firstName;
    const named = splitUnitName(g.firstName);
    if (numeric && unit) name = named.unit === unit ? g.firstName : `${named.base}(${unit})`;
    // 단위를 정하지 못했는데 이름에 단위 괄호가 남으면 틀린 단위를 보인다
    else if (numeric && named.unit) name = named.base;
    columns.push({ name, unit: numeric ? unit : null, numeric });

    // 숫자가 섞였는데 글자 열로 두면 합계에서 조용히 빠진다 — 알린다
    if (!numeric && numbers > 0) {
      lineage.columnWarnings.push(
        `열 "${name}": 숫자로 읽힌 값이 절반이 안 돼 글자 열로 두었습니다(숫자 ${numbers}, 읽지 못함 ${nonEmpty - numbers})`
      );
    }

    const bySource = new Map<number, { values: ResultValue[]; keys: ResultValue[] }>();
    for (const s of g.slots) {
      const p = prepared[s.src];
      bySource.set(
        s.src,
        numeric
          ? {
              values: numericValues(s, p, lineage),
              keys: p.rows.map((r) => numericKey(r.keys[s.col.index], s.col)),
            }
          : {
              values: p.rows.map((r) => textValue(r.values[s.col.index])),
              keys: p.rows.map((r) => textValue(r.keys[s.col.index])),
            }
      );
    }
    if (numeric && (unit === '%' || unit === '%p')) warnFractionPercent(name, g.slots, bySource, prepared, lineage);
    layers.push(bySource);
  }

  // 결과 열 이름이 겹치지 않게
  const used = new Map<string, number>();
  for (const c of columns) {
    const n = (used.get(c.name) ?? 0) + 1;
    used.set(c.name, n);
    if (n > 1) c.name = `${c.name} (${n})`;
  }

  if (prepared.length > 1) {
    groups.forEach((g, gi) => {
      const present = [...new Set(g.slots.map((s) => s.src))];
      if (present.length < prepared.length) {
        lineage.onlyIn.push({ column: columns[gi].name, files: present.map((src) => prepared[src].label) });
      }
    });
  }

  const rows: StackedRow[] = [];
  prepared.forEach((p, src) => {
    p.rows.forEach((r, i) => {
      const values = layers.map((bySource) => bySource.get(src)?.values[i] ?? null);
      const keys = layers.map((bySource) => bySource.get(src)?.keys[i] ?? null);
      if (spec.add_source_column) {
        values.unshift(p.fileName);
        keys.unshift(p.fileName);
      }
      rows.push({ source: src, row: r.row, values, keys });
    });
  });
  if (spec.add_source_column) columns.unshift({ name: SOURCE_COLUMN, unit: null, numeric: false });
  return { columns, rows, lineage };
}

function textValue(cell: Cell): ResultValue {
  return isBlank(cell) ? null : cell;
}

/** 키용 숫자 칸: 읽히면 값(scale 반영), 아니면 원래 글 — 근거는 집계용 쪽이 남긴다 */
function numericKey(cell: Cell, col: PreparedColumn): ResultValue {
  const p = parseNumber(cell);
  if (p.kind === 'empty') return null;
  if (p.kind === 'number' && !(p.unit && col.unit && p.unit !== col.unit)) {
    return col.scale === undefined ? p.value : roundValue(p.value * col.scale);
  }
  return String(cell).trim();
}

/** 숫자 열의 한 원천 값. 읽지 못한 칸·단위가 다른 칸은 null(0이 아님)로 두고 위치를 근거에 남긴다 */
function numericValues(slot: Slot, source: PreparedSource, lineage: Lineage): ResultValue[] {
  const { col } = slot;
  const where = (i: number) => ({
    file: source.file,
    table: source.table.id,
    row: source.rows[i].row,
    column: col.original,
  });
  // 열 단위를 정하지 못했는데 칸마다 다른 단위가 적혀 있으면 어느 칸도 믿을 수 없다
  const cellUnits = new Set<string>();
  for (const p of slot.parsed) if (p.kind === 'number' && p.unit) cellUnits.add(p.unit);
  const mixed = col.unit === null && cellUnits.size > 1;

  let parenthesized = 0;
  const out = slot.parsed.map((p, i): ResultValue => {
    if (p.kind === 'empty') return null;
    if (p.kind === 'unreadable') {
      lineage.unreadable.push({ ...where(i), text: p.text });
      return null;
    }
    const text = String(source.rows[i].values[col.index]);
    // 열이 원인데 칸에 '3,000천원' — 바꿔 더하지 않는다. 표기 실수인지 사람이 봐야 한다
    if (p.unit && col.unit && p.unit !== col.unit) {
      lineage.unreadable.push({ ...where(i), text, reason: `열 단위(${col.unit})와 다른 단위(${p.unit})` });
      return null;
    }
    if (p.unit && mixed) {
      lineage.unreadable.push({ ...where(i), text, reason: '칸마다 단위가 달라 어느 단위인지 알 수 없음' });
      return null;
    }
    if (p.parenthesized) parenthesized += 1;
    return col.scale === undefined ? p.value : roundValue(p.value * col.scale);
  });

  if (parenthesized > 0) {
    lineage.parenthesizedNegatives.push(
      `열 "${col.original}": ${source.label}의 괄호 숫자 ${parenthesized}개를 음수로 읽었습니다 — 괄호가 부분 금액이면 확인하세요`
    );
  }
  if (col.scale !== undefined) lineage.scaled.push({ file: source.file, column: col.original, factor: col.scale });
  return out;
}

// ── 입구 ────────────────────────────────────────────────────

function guard<T>(run: () => T): T | { ok: false; error: string } {
  try {
    return run();
  } catch (e) {
    if (e instanceof CombineError) return { ok: false, error: e.message };
    throw e;
  }
}

/** 쌓기까지만 — 행마다 키용·집계용 두 겹을 돌려준다(Task 3 단계와 시험이 쓴다) */
export function stackTables(sources: SourceTable[], spec: CombineSpec): StackResult {
  return guard((): StackResult => ({ ok: true, ...stack(sources, spec) }));
}

export function combineTables(sources: SourceTable[], spec: CombineSpec): CombineResult {
  return guard((): CombineResult => {
    const { columns, rows, lineage } = stack(sources, spec);

    // Task 3: 거르기(keys) → 묶기(keys)·집계(values) → 정렬(keys) → 합계 행(values)이 여기 이어진다
    lineage.rowCounts = { stacked: rows.length, filtered: rows.length, result: rows.length };
    return { ok: true, columns, rows: rows.map((r) => r.values), total: null, lineage };
  });
}
