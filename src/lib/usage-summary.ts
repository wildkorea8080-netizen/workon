// src/lib/usage-summary.ts
// 관리자 이용통계(비서별·직원별·부서별) — DB가 (묶음·활동·모델)마다 센 묶음(0058 `usage_summary`)을 화면 행으로 모은다.
// 순수 함수. DB·화면을 모른다. 묶음 규칙(어느 기록이 어느 묶음인지·토큰 셈)은 SQL에 있고, 여기서는 이름 붙이기·합치기·정렬만 한다.

import { getModel } from '@/lib/models';

export type UsageAxis = 'agent' | 'user' | 'department';

/** 한 행 안에서 모델·활동별로 다시 나눈 내역 */
export interface UsageBreakdown {
  key: string;
  label: string;
  count: number;
  inputTokens: number;
  outputTokens: number;
  costKrw: number;
}

export interface UsageSummaryRow {
  key: string;
  name: string;
  sub: string;
  count: number;
  inputTokens: number;
  outputTokens: number;
  costKrw: number;
  /** 어떤 모델을 얼마나 썼는지 — 토큰을 쓴 기록만 */
  models: UsageBreakdown[];
  /** 어떤 종류의 활동인지 */
  actions: UsageBreakdown[];
}

/** DB가 돌려준 묶음 하나(`usage_summary`의 원소) */
export interface UsageGroup {
  bucket: string;
  action: string;
  /** 토큰을 쓴 기록이면 모델 id, 아니면 null */
  model: string | null;
  count: number;
  input_tokens: number;
  output_tokens: number;
  cost_krw: number;
}

/** usage_logs.action을 담당자가 읽을 말로. 감사 화면과 같은 어휘를 쓴다 */
export const USAGE_ACTION_LABELS: Record<string, string> = {
  chat_message: 'AI 대화',
  qna_search: '문서 질의',
  generate_report: '보고서 생성',
  document_ocr: '스캔 문서 판독',
  conversation_title: '대화 제목 생성',
  document_generated: '문서 파일 생성',
  file_attached: '파일 첨부',
  table_merged: '표 합치기',
  work_generate: '업무 파일 만들기(AI)',
  work_revise: '업무 문서 AI 수정',
  prompt_enhance: '프롬프트 다듬기',
  document_tag_suggest: '문서 태그 초안(AI)',
  rag_eval_answer: '문서 찾기 평가 답변(AI)',
};

const num = (v: unknown) => {
  const n = typeof v === 'number' ? v : typeof v === 'string' ? Number(v) : 0;
  return Number.isFinite(n) ? n : 0;
};

/** DB 응답(jsonb 배열)을 묶음 목록으로 — 모양이 틀린 원소는 버린다 */
export function parseUsageGroups(raw: unknown): UsageGroup[] {
  if (!Array.isArray(raw)) return [];
  const out: UsageGroup[] = [];
  for (const g of raw) {
    if (!g || typeof g !== 'object') continue;
    const r = g as Record<string, unknown>;
    if (typeof r.bucket !== 'string' || typeof r.action !== 'string') continue;
    out.push({
      bucket: r.bucket,
      action: r.action,
      model: typeof r.model === 'string' && r.model ? r.model : null,
      count: num(r.count),
      input_tokens: num(r.input_tokens),
      output_tokens: num(r.output_tokens),
      cost_krw: num(r.cost_krw),
    });
  }
  return out;
}

function bump(list: UsageBreakdown[], key: string, label: string, g: UsageGroup) {
  let row = list.find((r) => r.key === key);
  if (!row) {
    row = { key, label, count: 0, inputTokens: 0, outputTokens: 0, costKrw: 0 };
    list.push(row);
  }
  row.count += g.count;
  row.inputTokens += g.input_tokens;
  row.outputTokens += g.output_tokens;
  row.costKrw += g.cost_krw;
}

/**
 * 묶음을 화면 행으로. 이름 사전에 없는 묶음은 '(삭제됨)'. 정렬은 원가 → 횟수 큰 순, 행 안의 모델은 원가 순, 활동은 횟수 순
 */
export function usageRowsFromGroups(groups: UsageGroup[], names: Map<string, { name: string; sub: string }>): UsageSummaryRow[] {
  const buckets = new Map<string, UsageSummaryRow>();
  for (const g of groups) {
    const named = names.get(g.bucket);
    const row = buckets.get(g.bucket) ?? {
      key: g.bucket,
      name: named?.name ?? '(삭제됨)',
      sub: named?.sub ?? '',
      count: 0,
      inputTokens: 0,
      outputTokens: 0,
      costKrw: 0,
      models: [],
      actions: [],
    };
    row.count += g.count;
    row.inputTokens += g.input_tokens;
    row.outputTokens += g.output_tokens;
    row.costKrw += g.cost_krw;
    if (g.model) bump(row.models, g.model, getModel(g.model).label, g);
    bump(row.actions, g.action, USAGE_ACTION_LABELS[g.action] ?? g.action, g);
    buckets.set(g.bucket, row);
  }
  const rows = [...buckets.values()].sort((a, b) => b.costKrw - a.costKrw || b.count - a.count);
  for (const row of rows) {
    row.models.sort((a, b) => b.costKrw - a.costKrw || b.count - a.count);
    row.actions.sort((a, b) => b.count - a.count);
  }
  return rows;
}
