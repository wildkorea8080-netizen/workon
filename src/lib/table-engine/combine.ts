/**
 * 표 합치기. 단계: 원천 준비 → 쌓기 → [거르기 → 묶기·집계 → 정렬 → 합계 행(Task 3)].
 * 원칙은 "그럴듯하지만 틀린 합계를 내지 않는다" — 의심스러우면 값을 빼고 근거에 남기거나 실패한다.
 * 이미 있는 합계 행을 다시 더하는 것, 단위가 다른 열을 섞는 것, 읽지 못한 칸을 0으로 치는 것이 막을 대상이다.
 */
import { columnNames } from '@/lib/attachments/header';
import type { Cell, ExtractedTable } from '@/lib/attachments/types';
import { parseNumber, type Parsed } from './number';
import { unitMagnitude } from './unit-names';
import { columnUnit, normalizeUnit } from './units';
import type { CombineResult, CombineSpec, Lineage, ResultColumn, ResultValue, SourceTable } from './types';

/** 지시가 틀렸을 때 던져 combineTables가 { ok:false }로 바꾼다 — 단계마다 실패를 실어 나르지 않으려고 */
class CombineError extends Error {}

function fail(message: string): never {
  throw new CombineError(message);
}

/** 원천 안에 이미 있는 합계 행 — 다시 더하면 두 배가 된다 */
const TOTAL_WORDS = new Set(['합계', '소계', '계', '총계']);
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
  /** 쌓을 때 맞추는 이름: 단위 괄호를 뗀 이름('예산(원)'과 '예산'이 같은 열이어야 단위 충돌을 잡는다) */
  key: string;
  /** cells의 열 번호 */
  index: number;
  unit: string | null;
  scale?: number;
}

interface PreparedRow {
  /** 원본 cells의 1부터 번호 */
  row: number;
  /** 세로 병합 글자를 아래로 채운 행(cells 열 번호 순) */
  values: Cell[];
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
    similarKeys: [],
    rowCounts: { stacked: 0, filtered: 0, result: 0 },
    truncated: false,
  };
}

// ── 1단계: 원천 준비 ─────────────────────────────────────────────

function prepareSource(source: SourceTable, lineage: Lineage): PreparedSource {
  const { spec, table } = source;
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

  // 판정(빈 행·합계 행)은 원래 칸으로, 값은 채운 칸으로. 채운 뒤에 판정하면 병합된 '총무과' 아래 '소계' 행의 첫 칸이
  // '총무과'가 되어 합계 행을 놓친다 — 두 번 더해진다
  const original: Cell[][] = [];
  for (let r = bodyStart; r < cells.length; r += 1) {
    original.push(Array.from({ length: width }, (_, c) => cells[r]?.[c] ?? null));
  }
  const filled = original.map((row) => [...row]);
  const mergedNumberAt = new Set<string>();
  for (const m of table.merges) {
    // 머리글에서 시작한 병합은 이미 열 이름에 들었다
    if (m.rows < 2 || m.row < bodyStart || m.col >= width) continue;
    const owner = cells[m.row]?.[m.col] ?? null;
    if (isBlank(owner)) continue;
    const at = m.row - bodyStart;
    if (parseNumber(owner).kind === 'number') {
      // 숫자는 주인 칸에만 — 아래로 채우면 같은 금액이 병합 행 수만큼 더해진다
      mergedNumberAt.add(`${at},${m.col}`);
      continue;
    }
    // 글자는 아래로 채운다 — 묶음 키가 비지 않게
    for (let r = at + 1; r < Math.min(at + m.rows, filled.length); r += 1) filled[r][m.col] = owner;
  }

  const skipWords = new Set((spec.skip_rows_matching ?? []).map((w) => squash(String(w))).filter((w) => w !== ''));
  const rows: PreparedRow[] = [];
  const bodyIndexes: number[] = [];
  let rowsIn = 0;
  original.forEach((orig, i) => {
    if (orig.every(isBlank)) return; // 빈 행은 근거에 남기지 않는다
    rowsIn += 1;
    const rowNo = bodyStart + i + 1;
    const first = squash(String(orig.find((c) => !isBlank(c))));
    const reason = TOTAL_WORDS.has(first) ? '합계 행' : skipWords.has(first) ? '지정한 글' : null;
    if (reason) {
      lineage.skippedRows.push({ file: spec.file, table: table.id, row: rowNo, reason, text: rowText(orig) });
      return;
    }
    rows.push({ row: rowNo, values: filled[i] });
    bodyIndexes.push(i);
  });

  // 머리글도 값도 없는 여백 열은 버린다 — 결과에 빈 열과 onlyIn 경고만 남긴다
  const referenced = new Set([...Object.keys(spec.rename ?? {}), ...Object.keys(spec.scale ?? {})]);
  const columns: PreparedColumn[] = names
    .map((name, index) => ({ original: name, name, key: name, index, unit: null as string | null }))
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
  }

  // 단위 괄호를 뗀 이름이 한 원천 안에서 겹치면('예산(천원)'·'예산(원)') 그 열들은 이름 그대로 맞춘다
  const baseCount = new Map<string, number>();
  for (const c of columns) {
    c.key = splitUnitName(c.name).base;
    baseCount.set(c.key, (baseCount.get(c.key) ?? 0) + 1);
  }
  for (const c of columns) {
    if ((baseCount.get(c.key) ?? 0) > 1) c.key = c.name;
    c.unit = columnUnit({ columnName: c.original, caption: table.caption, cells: rows.map((r) => r.values[c.index]) });
  }

  for (const [name, factor] of Object.entries(spec.scale ?? {})) {
    const col =
      columns.find((c) => c.name === name) ??
      columns.find((c) => c.original === name) ??
      columns.find((c) => c.key === name);
    if (!col) missingColumn(label, name, columns.map((c) => c.name));
    if (typeof factor !== 'number' || !Number.isFinite(factor) || factor <= 0) {
      fail(`${label}의 "${name}" scale은 0보다 큰 숫자여야 합니다.`);
    }
    col.scale = factor;
  }

  // 세로 병합 숫자는 쓰인 행에서만 근거에 남긴다
  rows.forEach((row, k) => {
    for (const c of columns) {
      if (mergedNumberAt.has(`${bodyIndexes[k]},${c.index}`)) {
        lineage.mergedNumbers.push({ file: spec.file, table: table.id, row: row.row, column: c.original });
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

interface Stacked {
  columns: ResultColumn[];
  rows: ResultValue[][];
}

/** 10의 d제곱을 글로 — 0.1 ** 8이 1.0000000000000002e-8로 나오지 않게 */
function powerOfTen(d: number): string {
  return d >= 0 ? `1${'0'.repeat(d)}` : `0.${'0'.repeat(-d - 1)}1`;
}

function unitConflict(group: ColumnGroup, known: Slot[], prepared: PreparedSource[]): never {
  const list = known.map((s) => `${prepared[s.src].label}=${s.col.unit}`).join(', ');
  const target = known[0].col.unit as string;
  const targetMag = unitMagnitude(target);
  let example: { slot: Slot; factor: string } | null = null;
  for (const s of known) {
    const mag = unitMagnitude(s.col.unit as string);
    if (s.col.unit !== target && mag && targetMag && mag.base === targetMag.base) {
      example = { slot: s, factor: powerOfTen(mag.exponent - targetMag.exponent) };
      break;
    }
  }
  const head = `열 "${group.key}"의 단위가 원천마다 다릅니다: ${list}.`;
  if (!example) fail(`${head} 서로 바꿀 수 없는 단위라 같은 열인지 확인하세요.`);
  fail(
    `${head} scale로 맞춘 뒤 다시 계산하세요(예: ${prepared[example.slot.src].file}의 "${example.slot.col.key}"에 ${example.factor}).`
  );
}

function stackSources(prepared: PreparedSource[], spec: CombineSpec, lineage: Lineage): Stacked {
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
  /** groups 순서대로, 원천 번호 → 그 원천 행들의 값 */
  const values: Map<number, ResultValue[]>[] = [];

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
      // scale을 준 원천은 사람이 맞춘 것이라 비교에서 뺀다
      const known = g.slots.filter((s) => s.col.scale === undefined && s.col.unit !== null);
      const distinct = new Set(known.map((s) => s.col.unit));
      if (distinct.size > 1) unitConflict(g, known, prepared);
      unit = known[0]?.col.unit ?? null;
      if (unit) {
        for (const s of g.slots) {
          if (s.col.scale === undefined && s.col.unit === null) {
            lineage.unitWarnings.push(`열 "${g.key}": ${prepared[s.src].label}은 단위를 알 수 없습니다 — 같은 단위인지 확인하세요`);
          }
        }
      }
    } else {
      const scaled = g.slots.find((s) => s.col.scale !== undefined);
      if (scaled) fail(`${prepared[scaled.src].label}의 "${scaled.col.name}"는 숫자 열이 아니라 scale을 쓸 수 없습니다.`);
    }

    const bySource = new Map<number, ResultValue[]>();
    for (const s of g.slots) {
      const p = prepared[s.src];
      bySource.set(s.src, numeric ? numericValues(s, p, lineage) : s.parsed.map((_, i) => textValue(p.rows[i].values[s.col.index])));
    }
    values.push(bySource);

    let name = g.firstName;
    const named = splitUnitName(g.firstName);
    if (numeric && unit) name = named.unit === unit ? g.firstName : `${named.base}(${unit})`;
    // 단위를 정하지 못했는데 이름에 단위 괄호가 남으면(모든 원천에 scale) 틀린 단위를 보인다
    else if (numeric && named.unit) name = named.base;
    columns.push({ name, unit: numeric ? unit : null, numeric });
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

  const rows: ResultValue[][] = [];
  prepared.forEach((p, src) => {
    p.rows.forEach((_, i) => {
      const row = values.map((bySource) => bySource.get(src)?.[i] ?? null);
      if (spec.add_source_column) row.unshift(p.fileName);
      rows.push(row);
    });
  });
  if (spec.add_source_column) columns.unshift({ name: SOURCE_COLUMN, unit: null, numeric: false });
  return { columns, rows };
}

function textValue(cell: Cell): ResultValue {
  return isBlank(cell) ? null : cell;
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

export function combineTables(sources: SourceTable[], spec: CombineSpec): CombineResult {
  try {
    if (sources.length === 0) fail('합칠 표가 없습니다.');
    const labels = sources.map((s) => `${s.spec.file}/${s.spec.table}`);
    for (const want of spec.sources ?? []) {
      if (!sources.some((s) => s.spec.file === want.file && s.spec.table === want.table)) {
        fail(`${want.file}/${want.table} 표를 찾지 못했습니다. 받은 표: ${labels.join(', ')}`);
      }
    }

    const lineage = emptyLineage();
    const prepared = sources.map((s) => prepareSource(s, lineage));
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
    const stacked = stackSources(prepared, spec, lineage);

    // Task 3: 거르기 → 묶기·집계 → 정렬 → 합계 행이 여기 이어진다
    const { columns, rows } = stacked;
    lineage.rowCounts = { stacked: rows.length, filtered: rows.length, result: rows.length };
    return { ok: true, columns, rows, total: null, lineage };
  } catch (e) {
    if (e instanceof CombineError) return { ok: false, error: e.message };
    throw e;
  }
}
