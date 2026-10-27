// src/lib/work/workflows/collection/aggregate.ts
import { createHash } from 'crypto';
import type { ExtractedTable } from '@/lib/attachments/types';
import { stackTables, roundValue } from '@/lib/table-engine/combine';
import { unitMagnitude, normalizeUnit, unitDimension } from '@/lib/table-engine/unit-names';

/**
 * 자료 취합 — 부서별 제출 표를 모아 항목별로 더한다. **숫자는 프로그램이 낸다**(모델은 숫자를 만들지 않는다, 개편 04 문서 8절).
 * DB·저장소·모델을 모르는 순수 함수다.
 *
 * 표 읽기·합계 행 빼기·병합 숫자·읽지 못한 칸·단위 찾기는 기존 표 엔진(stackTables)을 그대로 쓴다. 여기서 더하는 것:
 *  - 제출 부서 찾기(파일 이름 → 내용, 직원이 정하면 그것)
 *  - 중복 제출 후보(같은 파일 해시·같은 표 내용) — **두 번 더하지 않고** 확인 사항으로 알린다(직원이 '포함'으로 바꿀 수 있음)
 *  - 항목 ↔ 열 대응, 돈 단위 통일(원·천원·백만원 — 단위 크기로 환산), 집행률 같은 파생 값(집행액 ÷ 예산액)
 *  - 미제출 부서 → 잠정 집계(직원이 확인할 때까지 막는 사항), 일부만 읽힌 표 → 전체 완료를 막는다
 *  - 원본 대응: 값마다 원천 파일·표·**추출 표의 행 번호**(시트의 셀 주소를 지어내지 않는다)
 * 읽지 못한 칸·빈 칸은 0이 아니다.
 */
export interface CollectionDecisions {
  /** 직원이 뺀 원자료 */
  excludedSourceIds: string[];
  /** 중복 후보지만 직원이 '다른 자료'라고 확인해 넣은 원자료 */
  includedSourceIds: string[];
  outputUnit: '원' | '천원' | '백만원';
  /** 미제출 부서가 있어도 잠정 집계로 쓰기로 확인함 */
  allowProvisional: boolean;
  /** 원자료 → 부서(직원이 정함) */
  departmentOverrides: Record<string, string>;
}

export const DEFAULT_DECISIONS: CollectionDecisions = {
  excludedSourceIds: [],
  includedSourceIds: [],
  outputUnit: '원',
  allowProvisional: false,
  departmentOverrides: {},
};

export interface CollectionSourceInput {
  id: string;
  name: string;
  sha256: string;
  text: string;
  tables: ExtractedTable[];
  truncated: boolean;
}

export type FieldKind = 'money' | 'count' | 'rate' | 'number';

export interface CollectionField {
  name: string;
  kind: FieldKind;
  unit: string | null;
  /** 파생 값이면 계산식(사람이 읽는 글) */
  derived: string | null;
}

export interface CollectionSourceReport {
  id: string;
  name: string;
  department: string | null;
  departmentBy: 'override' | 'file_name' | 'content' | null;
  status: 'used' | 'duplicate' | 'excluded' | 'no_department' | 'no_table';
  duplicateOf: string | null;
  table: string | null;
  columnMap: Record<string, string | null>;
  units: Record<string, string | null>;
  rowsUsed: number;
}

export interface TraceRow {
  department: string;
  field: string;
  sourceId: string;
  sourceName: string;
  table: string;
  /** 추출 표(cells)의 1부터 행 번호 — 시트 행 번호가 아니다 */
  extractedRow: number;
  rawValue: number;
  unit: string | null;
  value: number;
}

export interface CollectionReviewItem {
  severity: 'blocking' | 'warning' | 'info';
  code: string;
  message: string;
}

export interface CollectionResult {
  schema: 'collection/1';
  outputUnit: CollectionDecisions['outputUnit'];
  fields: CollectionField[];
  departments: { name: string; status: 'submitted' | 'missing'; sourceIds: string[]; values: Record<string, number | null> }[];
  totals: Record<string, number | null>;
  provisional: boolean;
  sources: CollectionSourceReport[];
  trace: TraceRow[];
  skippedRows: { sourceName: string; table: string; row: number; text: string; reason: string }[];
  unreadable: { sourceName: string; table: string; row: number; column: string; text: string }[];
  review: CollectionReviewItem[];
  decisions: CollectionDecisions;
}

const norm = (s: string) => s.normalize('NFC').replace(/[\s ·()[\]{}<>]/g, '').toLowerCase();

export function fieldKind(name: string): FieldKind {
  if (/률|율|비율|비중/.test(name)) return 'rate';
  if (/예산|집행|금액|비용|사업비|액$|원$/.test(name)) return 'money';
  if (/수$|인원|명$|건수|횟수/.test(name)) return 'count';
  return 'number';
}

/** 항목 이름의 핵심어 — '부서별 예산액' → '예산', '참여자 수' → '참여자' */
export function fieldStem(name: string): string {
  return norm(name)
    .replace(/^부서별|^분기|^총/, '')
    .replace(/(금액|액|수|인원|현황|합계|계)$/, '')
    .trim();
}

function matchColumn(field: string, columns: string[], used: Set<number>): number {
  const stem = fieldStem(field);
  if (!stem) return -1;
  const cand: { i: number; score: number }[] = [];
  columns.forEach((c, i) => {
    if (used.has(i)) return;
    const nc = norm(c).replace(/\(.*?\)|단위.*/g, '');
    if (!nc) return;
    if (nc === norm(field)) cand.push({ i, score: 3 });
    else if (fieldStem(c) === stem) cand.push({ i, score: 2 });
    else if (nc.includes(stem) || (fieldStem(c).length >= 2 && stem.includes(fieldStem(c)))) cand.push({ i, score: 1 });
  });
  cand.sort((a, b) => b.score - a.score);
  // 같은 점수가 여럿이면 어느 열인지 모른다 — 짐작하지 않는다
  if (cand.length > 1 && cand[0].score === cand[1].score) return -1;
  return cand[0]?.i ?? -1;
}

function detectDepartment(src: CollectionSourceInput, expected: string[], overrides: Record<string, string>): { name: string | null; by: CollectionSourceReport['departmentBy'] } {
  const o = overrides[src.id];
  if (o && expected.includes(o)) return { name: o, by: 'override' };
  // 긴 이름부터 — '교육팀'과 '교육지원팀'이 함께 있으면 긴 쪽이 먼저 맞아야 한다
  const byLen = [...expected].sort((a, b) => b.length - a.length);
  const inName = byLen.filter((d) => norm(src.name).includes(norm(d)));
  if (inName.length >= 1) return { name: inName[0], by: 'file_name' };
  const head = norm([src.tables.map((t) => `${t.caption ?? ''} ${t.title}`).join(' '), src.text.slice(0, 2000)].join(' '));
  const inContent = byLen.filter((d) => head.includes(norm(d)));
  if (inContent.length === 1) return { name: inContent[0], by: 'content' };
  return { name: null, by: null };
}

function tableFingerprint(t: ExtractedTable): string {
  return createHash('sha256').update(JSON.stringify(t.cells.slice(t.header.to + 1))).digest('hex');
}

function convertMoney(value: number, unit: string | null, out: string): number | null {
  if (!unit) return null;
  const from = unitMagnitude(unit);
  const to = unitMagnitude(out);
  if (!from || !to || from.base !== to.base) return null;
  return roundValue(value * 10 ** (from.exponent - to.exponent));
}

const sum = (xs: (number | null)[]): number | null => {
  const nums = xs.filter((x): x is number => typeof x === 'number');
  return nums.length ? roundValue(nums.reduce((a, b) => a + b, 0)) : null;
};

export function aggregateCollection(input: {
  sources: CollectionSourceInput[];
  expectedDepartments: string[];
  fieldNames: string[];
  decisions?: Partial<CollectionDecisions>;
}): CollectionResult {
  const decisions: CollectionDecisions = { ...DEFAULT_DECISIONS, ...input.decisions };
  const outUnit = normalizeUnit(decisions.outputUnit) ?? '원';
  const expected = [...new Set(input.expectedDepartments.map((d) => d.trim()).filter(Boolean))];
  const fields: CollectionField[] = input.fieldNames.map((name) => {
    const kind = fieldKind(name);
    return { name, kind, unit: kind === 'money' ? outUnit : null, derived: null };
  });
  const budgetField = fields.find((f) => f.kind === 'money' && /예산/.test(f.name));
  const spentField = fields.find((f) => f.kind === 'money' && /집행/.test(f.name));
  for (const f of fields) {
    if (f.kind === 'rate' && /집행/.test(f.name) && budgetField && spentField) {
      f.derived = `${spentField.name} ÷ ${budgetField.name} × 100`;
      f.unit = '%';
    }
  }
  const measured = fields.filter((f) => !f.derived);
  const review: CollectionReviewItem[] = [];
  const reports: CollectionSourceReport[] = [];
  const trace: TraceRow[] = [];
  const skippedRows: CollectionResult['skippedRows'] = [];
  const unreadable: CollectionResult['unreadable'] = [];
  const conversions = new Set<string>();

  // 중복 후보 — 같은 파일 해시 또는 같은 표 내용. 먼저 올린 것을 쓰고 뒤의 것은 뺀다(직원이 넣을 수 있다)
  const seenHash = new Map<string, string>();
  const seenTable = new Map<string, string>();
  const perSourceValues = new Map<string, Record<string, number | null>>();

  for (const src of input.sources) {
    const dept = detectDepartment(src, expected, decisions.departmentOverrides);
    const report: CollectionSourceReport = {
      id: src.id,
      name: src.name,
      department: dept.name,
      departmentBy: dept.by,
      status: 'used',
      duplicateOf: null,
      table: null,
      columnMap: {},
      units: {},
      rowsUsed: 0,
    };
    reports.push(report);
    const first = src.tables[0];
    const dupOf = (src.sha256 && seenHash.get(src.sha256)) || (first && seenTable.get(tableFingerprint(first))) || null;
    if (src.sha256 && !seenHash.has(src.sha256)) seenHash.set(src.sha256, src.id);
    if (first && !seenTable.has(tableFingerprint(first))) seenTable.set(tableFingerprint(first), src.id);
    if (decisions.excludedSourceIds.includes(src.id)) {
      report.status = 'excluded';
      continue;
    }
    if (dupOf && !decisions.includedSourceIds.includes(src.id)) {
      report.status = 'duplicate';
      report.duplicateOf = dupOf;
      const of = input.sources.find((s) => s.id === dupOf)?.name ?? '';
      review.push({ severity: 'warning', code: 'DUPLICATE_CANDIDATE', message: `'${src.name}'은(는) '${of}'과(와) 같은 내용이라 중복 제출 후보로 보고 합산에서 뺐습니다. 다른 자료라면 '포함'으로 바꾸세요.` });
      continue;
    }
    if (!dept.name) {
      report.status = 'no_department';
      review.push({ severity: 'warning', code: 'DEPARTMENT_UNKNOWN', message: `'${src.name}'이(가) 어느 부서 자료인지 알 수 없어 합산에서 뺐습니다. 부서를 지정하세요.` });
      continue;
    }
    if (src.truncated) {
      review.push({ severity: 'blocking', code: 'SOURCE_TRUNCATED', message: `'${src.name}'은(는) 읽기 상한에 걸려 일부만 읽었습니다. 전체 취합으로 쓸 수 없습니다 — 파일을 나눠 올리세요.` });
    }

    // 항목이 가장 많이 맞는 표를 쓴다
    let best: { t: ExtractedTable; map: Map<string, number> } | null = null;
    for (const t of src.tables) {
      const used = new Set<number>();
      const map = new Map<string, number>();
      for (const f of measured) {
        const i = matchColumn(f.name, t.columns, used);
        if (i >= 0) {
          used.add(i);
          map.set(f.name, i);
        }
      }
      if (map.size && (!best || map.size > best.map.size)) best = { t, map };
    }
    if (!best) {
      report.status = 'no_table';
      review.push({ severity: 'warning', code: 'NO_MATCHING_TABLE', message: `'${src.name}'에서 취합 항목(${measured.map((f) => f.name).join(', ')})에 맞는 표를 찾지 못했습니다.` });
      continue;
    }
    report.table = best.t.id;
    const rename: Record<string, string> = {};
    for (const [field, i] of best.map) rename[best.t.columns[i]] = field;
    const stacked = stackTables([{ file: 'a1', fileName: src.name, table: best.t }], { sources: [{ file: 'a1', table: best.t.id, rename }] });
    if (!stacked.ok) {
      review.push({ severity: 'warning', code: 'TABLE_UNREADABLE', message: `'${src.name}' 표를 계산하지 못했습니다: ${stacked.error.slice(0, 200)}` });
      report.status = 'no_table';
      continue;
    }
    for (const s of stacked.lineage.skippedRows) skippedRows.push({ sourceName: src.name, table: s.table, row: s.row, text: s.text, reason: s.reason });
    for (const u of stacked.lineage.unreadable) unreadable.push({ sourceName: src.name, table: u.table, row: u.row, column: u.column, text: u.text });
    report.rowsUsed = stacked.rows.length;
    const values: Record<string, number | null> = {};
    for (const f of measured) {
      // 엔진은 단위를 이름 뒤에 붙인다('예산액(천원)') — 바꾼 이름(앞부분)으로 찾는다
      const ci = stacked.columns.findIndex((c) => c.name === f.name || c.name.startsWith(`${f.name}(`));
      report.columnMap[f.name] = best.map.has(f.name) ? best.t.columns[best.map.get(f.name)!] : null;
      if (ci < 0) {
        values[f.name] = null;
        review.push({ severity: 'warning', code: 'FIELD_NOT_FOUND', message: `'${src.name}'에 '${f.name}' 항목이 없습니다(빈 값으로 둠 — 0으로 치지 않음).` });
        continue;
      }
      const col = { ...stacked.columns[ci] };
      // 표 위 글(캡션)의 돈 단위가 셈 항목(참여자 수 등)에 붙은 경우 — 표 전체 글이라 이 열 것이 아니다. 그 단위는 쓰지 않는다
      if (f.kind !== 'money' && col.unitSource === 'caption' && col.unit && unitDimension(col.unit) === '돈') col.unit = null;
      report.units[f.name] = col.unit;
      const parts: number[] = [];
      for (const r of stacked.rows) {
        const v = r.values[ci];
        if (typeof v !== 'number') continue;
        let conv: number | null = v;
        if (f.kind === 'money') {
          conv = convertMoney(v, col.unit, outUnit);
          if (conv === null) continue;
          if (col.unit !== outUnit) conversions.add(`${src.name} '${f.name}' ${col.unit} → ${outUnit}`);
        }
        parts.push(conv);
        trace.push({ department: dept.name, field: f.name, sourceId: src.id, sourceName: src.name, table: best.t.id, extractedRow: r.row, rawValue: v, unit: col.unit, value: conv });
      }
      if (f.kind === 'money' && !col.unit) {
        values[f.name] = null;
        review.push({ severity: 'blocking', code: 'UNIT_UNKNOWN', message: `'${src.name}'의 '${f.name}' 단위를 알 수 없어 더하지 않았습니다. 표 위에 '(단위: 천원)'처럼 적은 파일로 다시 올리거나 단위를 확인하세요.` });
        continue;
      }
      values[f.name] = sum(parts);
    }
    perSourceValues.set(src.id, values);
  }

  // 부서별 합 — 한 부서에 쓸 자료가 둘 이상이면 더하되 알린다
  const departments = expected.map((name) => {
    const used = reports.filter((r) => r.status === 'used' && r.department === name);
    const vals: Record<string, number | null> = {};
    for (const f of measured) vals[f.name] = sum(used.map((r) => perSourceValues.get(r.id)?.[f.name] ?? null));
    if (used.length > 1) review.push({ severity: 'warning', code: 'MULTIPLE_SUBMISSIONS', message: `${name} 자료가 ${used.length}개라 모두 더했습니다. 같은 자료의 수정본이면 하나를 빼세요.` });
    return { name, status: (used.length ? 'submitted' : 'missing') as 'submitted' | 'missing', sourceIds: used.map((r) => r.id), values: vals };
  });
  const totals: Record<string, number | null> = {};
  for (const f of measured) totals[f.name] = sum(departments.filter((d) => d.status === 'submitted').map((d) => d.values[f.name]));
  for (const f of fields.filter((x) => x.derived)) {
    const rate = (v: Record<string, number | null>) => {
      const b = v[budgetField!.name];
      const s = v[spentField!.name];
      return typeof b === 'number' && typeof s === 'number' && b !== 0 ? roundValue((s / b) * 100) : null;
    };
    for (const d of departments) d.values[f.name] = rate(d.values);
    totals[f.name] = rate(totals);
  }

  const missing = departments.filter((d) => d.status === 'missing').map((d) => d.name);
  const provisional = missing.length > 0;
  if (provisional) {
    review.push(
      decisions.allowProvisional
        ? { severity: 'info', code: 'PROVISIONAL', message: `미제출 부서(${missing.join(', ')})를 뺀 잠정 집계로 쓰기로 확인했습니다. 결과에 '잠정'이 표시됩니다.` }
        : { severity: 'blocking', code: 'MISSING_DEPARTMENT', message: `미제출 부서: ${missing.join(', ')}. 이대로 '미제출 부서를 제외한 잠정 집계'로 쓸지 확인하세요.` }
    );
  }
  if (conversions.size) review.push({ severity: 'info', code: 'UNIT_CONVERTED', message: `단위를 ${outUnit}(으)로 맞췄습니다: ${[...conversions].join('; ')}` });
  if (skippedRows.length) review.push({ severity: 'info', code: 'SUMMARY_ROWS_EXCLUDED', message: `원자료 안의 합계·소계 행 ${skippedRows.length}개를 다시 더하지 않으려고 뺐습니다.` });
  if (unreadable.length) review.push({ severity: 'warning', code: 'UNREADABLE_CELLS', message: `숫자로 읽지 못한 칸 ${unreadable.length}개는 더하지 않았습니다(0으로 치지 않음). '원본 대응' 시트에서 확인하세요.` });

  return { schema: 'collection/1', outputUnit: outUnit as CollectionDecisions['outputUnit'], fields, departments, totals, provisional, sources: reports, trace, skippedRows, unreadable, review, decisions };
}

/** 저장된 직원 결정을 믿지 않고 꼴을 다시 맞춘다 */
export function parseDecisions(input: unknown, sourceIds: string[], expected: string[]): CollectionDecisions {
  const o = (input && typeof input === 'object' ? input : {}) as Record<string, unknown>;
  const ids = (v: unknown) => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string' && sourceIds.includes(x)) : []);
  const overrides: Record<string, string> = {};
  if (o.departmentOverrides && typeof o.departmentOverrides === 'object') {
    for (const [k, v] of Object.entries(o.departmentOverrides as Record<string, unknown>)) if (sourceIds.includes(k) && typeof v === 'string' && expected.includes(v)) overrides[k] = v;
  }
  return {
    excludedSourceIds: ids(o.excludedSourceIds),
    includedSourceIds: ids(o.includedSourceIds),
    outputUnit: o.outputUnit === '천원' || o.outputUnit === '백만원' ? o.outputUnit : '원',
    allowProvisional: o.allowProvisional === true,
    departmentOverrides: overrides,
  };
}
