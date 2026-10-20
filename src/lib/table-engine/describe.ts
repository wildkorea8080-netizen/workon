/**
 * 지시(CombineSpec)를 사람이 읽는 문장으로 — 엑셀 '계산 근거' 시트와 도구 결과에 실린다.
 * AI가 무엇을 하라고 했는지(지시)를 적는다. 실제로 무엇을 빼고 바꿨는지는 Lineage가 따로 남긴다
 */
import { AGGREGATE_LABELS } from './combine';
import type { CombineSpec } from './types';

const OP_TEXT: Record<string, string> = { '=': '=', '!=': '≠', '>': '>', '>=': '≥', '<': '<', '<=': '≤' };

function list<T>(value: T[] | undefined): T[] {
  return Array.isArray(value) ? value : [];
}

export function describeSpec(spec: CombineSpec, fileNames: Record<string, string>): string[] {
  const out: string[] = [];
  const sources = list(spec.sources);
  const label = (s: { file: string; table: string }) => `${fileNames[s.file] ?? s.file}(${s.table})`;
  out.push(`원천: ${sources.map(label).join(', ')}`);

  for (const s of sources) {
    const at = label(s);
    const hr = s.header_rows;
    if (Array.isArray(hr) && hr.length === 2) out.push(`${at}: 머리글 ${hr[0] === hr[1] ? hr[0] : `${hr[0]}~${hr[1]}`}행`);
    const renamed = Object.entries(s.rename ?? {});
    if (renamed.length > 0) out.push(`${at}: 열 이름 바꿈 ${renamed.map(([from, to]) => `${from} → ${to}`).join(', ')}`);
    const scaled = Object.entries(s.scale ?? {});
    if (scaled.length > 0) out.push(`${at}: ${scaled.map(([col, factor]) => `${col} × ${factor}`).join(', ')}`);
    const skip = list(s.skip_rows_matching);
    if (skip.length > 0) out.push(`${at}: 첫 칸이 ${skip.join('·')}인 행 뺌`);
  }
  if (spec.add_source_column) out.push('출처 열을 붙임');

  const filters = list(spec.filter);
  if (filters.length > 0) {
    const conds = filters.map((f) =>
      f.op === 'contains' ? `${f.column}에 "${f.value}" 포함` : `${f.column} ${OP_TEXT[f.op] ?? f.op} ${f.value}`
    );
    out.push(`거르기: ${conds.join(', ')}`);
  }

  const groups = list(spec.group_by);
  const aggs = list(spec.aggregate).map(
    (a) => `${a.column} ${AGGREGATE_LABELS[a.fn] ?? a.fn}${a.as ? `("${a.as}")` : ''}`
  );
  if (groups.length > 0 && aggs.length > 0) out.push(`${groups.join('·')} 기준으로 묶어 ${aggs.join(', ')}`);
  else if (groups.length > 0) out.push(`${groups.join('·')} 기준으로 묶음`);
  else if (aggs.length > 0) out.push(`전체 ${aggs.join(', ')}`);

  const sorts = list(spec.sort);
  if (sorts.length > 0) out.push(`정렬: ${sorts.map((s) => `${s.column} ${s.desc ? '내림차순' : '오름차순'}`).join(', ')}`);
  if (spec.total_row) out.push('맨 아래 합계 행');
  return out;
}
