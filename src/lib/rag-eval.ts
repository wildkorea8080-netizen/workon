// src/lib/rag-eval.ts
// 배치 문서 찾기 평가(2026-11-04) — 순수 규칙. 화면과 라우트가 함께 쓴다(서버 모듈을 가져오지 않는다).
//
// 기관이 '질문 · 기대 문서 · 기대 쪽' 세트를 만들어 두고, 비서의 문서 찾기(대화와 같은 NODA /context·하한 0.80·이 비서 행 맞춤)가
// 맞는 문서를 찾는지 한 번에 잰다. **검색만** 재고 AI 답변은 만들지 않는다(모델 비용 없음). 세트는 사람이 만든다 —
// 알리웍스 '리트리버 최적화'도 데이터셋을 사람이 올린다.

import Papa from 'papaparse';
import type { RagEvalAnswer, RagEvalAnswerSummary, RagEvalAnswerVerdict } from '@/lib/rag-eval-answer';
import { RAG_EVAL_JUDGE_LABELS, judgeNote } from '@/lib/rag-eval-judge';

export const RAG_EVAL_MAX_QUESTIONS = 50;
export const RAG_EVAL_QUESTION_MAX = 500;
export const RAG_EVAL_EXPECTED_MAX = 120;
/** 기대 답 핵심어(넷째 칸, 2026-11-08) — ';'로 나눠 5개까지, 하나 60자 */
export const RAG_EVAL_MAX_KEYWORDS = 5;
export const RAG_EVAL_KEYWORD_MAX = 60;

/** 세트 한 줄. `expected`가 null이면 '근거가 없어야 맞는 질문'(엉뚱한 질문 — 하한이 걸러야 한다) */
export interface RagEvalRow {
  line: number;
  question: string;
  expected: string | null;
  page: number | null;
  /** 기대 답 핵심어 — 답변까지 평가할 때 답에 모두 들어 있어야 맞음. 적지 않았으면 칸이 없다 */
  keywords?: string[];
}

/** 찾은 조각 중 판정에 쓰는 것만 */
export interface RagEvalChunk {
  documentTitle?: string;
  page?: number | null;
  similarity: number;
  /** 공통 자료실 조각(S5)이면 'common' — 상위 문서 이름 앞에 [공통]을 붙인다 */
  scope?: 'common';
}

/** 찾은 범위 — 'chat' = 대화와 같은 찾기(비서 보관함 + 공통 자료실, 2026-11-05부터). 그 전 기록은 칸이 없고 비서 보관함만 찾았다 */
export type RagEvalScope = 'agent' | 'chat';

/**
 * hit = 기대 문서를 찾음 · miss = 근거는 왔지만 기대 문서가 없음 · no_evidence = 기대 문서가 있는데 근거가 하나도 없음 ·
 * correct_empty = 엉뚱한 질문에 근거 없음(맞음) · false_evidence = 엉뚱한 질문에 근거가 붙음 · error = 찾기 실패(NODA)
 */
export type RagEvalVerdict = 'hit' | 'miss' | 'no_evidence' | 'correct_empty' | 'false_evidence' | 'error';

export interface RagEvalResult {
  line: number;
  question: string;
  expected: string | null;
  page: number | null;
  verdict: RagEvalVerdict;
  /** 기대 문서가 처음 나온 순위(1부터). 못 찾았으면 null */
  rank: number | null;
  /** 기대 쪽을 줬을 때 — 기대 문서의 조각 중 그 쪽이 있었나. 쪽을 안 줬거나 문서를 못 찾았으면 null */
  pageMatch: boolean | null;
  chunkCount: number;
  topSimilarity: number | null;
  /** 위에서부터 서로 다른 문서 이름 3개까지(근거 원문은 남기지 않는다). 공통 자료실 문서는 '[공통] 이름' */
  topDocuments: string[];
  /** 근거에 공통 자료실 조각이 있었나(없으면 칸이 없다 — 옛 기록과 같은 꼴) */
  commonEvidence?: true;
  /** 기대 답 핵심어(세트에 적었을 때만) */
  keywords?: string[];
  /** 답변까지 평가한 실행에만(2026-11-08, rag-eval-answer.ts) */
  answer?: RagEvalAnswer;
}

export interface RagEvalSummary {
  questions: number;
  /** 기대 문서가 있는 질문 수 / 그중 찾은 수 */
  expected: number;
  hits: number;
  hitRate: number | null;
  /** 기대 쪽을 준 질문 수 / 그중 쪽까지 맞은 수 */
  withPage: number;
  pageHits: number;
  pageHitRate: number | null;
  /** 평균 역순위(기대 문서 있는 질문, 못 찾으면 0) — 1이면 늘 첫 근거 */
  mrr: number | null;
  /** 엉뚱한 질문 수 / 그중 근거 없이 걸러진 수 */
  offTopic: number;
  offTopicRejected: number;
  offTopicRejectRate: number | null;
  errors: number;
  counts: Record<RagEvalVerdict, number>;
  /** 찾은 범위 — 없으면 옛 기록(비서 보관함만) */
  searchScope?: RagEvalScope;
  /** 근거에 공통 자료실 조각이 있던 질문 수(찾기 실패 제외) */
  commonEvidenceQuestions?: number;
  /** 답변까지 평가한 실행에만 */
  answers?: RagEvalAnswerSummary;
  /** 세트의 지문(2026-11-12, `ragEvalSetKey`) — 같은 세트로 잰 다른 비서의 실행을 찾는다. 옛 기록에는 없다(결과에서 다시 셈) */
  setKey?: string;
}

const clean = (v: unknown) => (typeof v === 'string' ? v.normalize('NFC').replace(/[\u0000-\u001f\u007f\p{Cf}]/gu, ' ').replace(/\s+/g, ' ').trim() : '');
const HEADER = /^(질문|question)$/i;

/**
 * 붙여 넣은 세트(엑셀에서 복사한 탭 구분 또는 CSV)를 읽는다. 첫 줄의 첫 칸이 '질문'이면 머리글로 보고 건너뛴다.
 * 칸: 질문, 기대 문서(이름 일부, 비우면 엉뚱한 질문), 기대 쪽(선택, 숫자), 기대 답 핵심어(선택, ';'로 나눔 — 답변까지 평가할 때 본다).
 * 잘못된 줄은 줄 번호와 함께 모두 알린다
 */
export function parseRagEvalSet(text: string): { ok: true; rows: RagEvalRow[] } | { ok: false; errors: string[] } {
  if (typeof text !== 'string' || !text.trim()) return { ok: false, errors: ['평가 세트를 붙여 넣어 주세요(한 줄에 질문, 기대 문서, 기대 쪽).'] };
  if (text.length > 200_000) return { ok: false, errors: ['평가 세트가 너무 깁니다.'] };
  const delimiter = text.split(/\r?\n/).some((l) => l.includes('\t')) ? '\t' : ',';
  // 앞을 다듬으면 첫 줄의 빈 첫 칸(탭)이 사라진다 — 끝만 다듬고, 빈 줄은 줄 번호가 밀리지 않게 직접 건너뛴다
  const parsed = Papa.parse<string[]>(text.replace(/\s+$/, ''), { delimiter, skipEmptyLines: false });
  const errors: string[] = [];
  const rows: RagEvalRow[] = [];
  let first = true;
  parsed.data.forEach((cells, index) => {
    const line = index + 1;
    if (!cells.some((cell) => clean(cell))) return;
    const isFirst = first; first = false;
    if (isFirst && HEADER.test(clean(cells[0]))) return;
    const question = clean(cells[0]);
    const expected = clean(cells[1]);
    const pageText = clean(cells[2]);
    const keywords = clean(cells[3]).split(/[;；]/).map((k) => k.trim()).filter(Boolean);
    if (!question) { errors.push(`${line}번째 줄: 질문이 비었습니다.`); return; }
    if (question.length > RAG_EVAL_QUESTION_MAX) { errors.push(`${line}번째 줄: 질문은 ${RAG_EVAL_QUESTION_MAX}자 이내로 적어 주세요.`); return; }
    if (expected.length > RAG_EVAL_EXPECTED_MAX) { errors.push(`${line}번째 줄: 기대 문서 이름은 ${RAG_EVAL_EXPECTED_MAX}자 이내로 적어 주세요.`); return; }
    const pageMatch = /^(?:p\.?\s*)?(\d{1,5})(?:\s*쪽)?$/i.exec(pageText);
    if (pageText && !pageMatch) { errors.push(`${line}번째 줄: 기대 쪽은 숫자로 적어 주세요(예: 12).`); return; }
    if (pageText && !expected) { errors.push(`${line}번째 줄: 기대 쪽을 적으려면 기대 문서도 적어 주세요.`); return; }
    if (keywords.length && !expected) { errors.push(`${line}번째 줄: 기대 답 핵심어를 적으려면 기대 문서도 적어 주세요.`); return; }
    if (keywords.length > RAG_EVAL_MAX_KEYWORDS) { errors.push(`${line}번째 줄: 기대 답 핵심어는 ${RAG_EVAL_MAX_KEYWORDS}개까지 적어 주세요(';'로 나눔).`); return; }
    if (keywords.some((k) => k.length > RAG_EVAL_KEYWORD_MAX)) { errors.push(`${line}번째 줄: 기대 답 핵심어는 하나에 ${RAG_EVAL_KEYWORD_MAX}자 이내로 적어 주세요.`); return; }
    rows.push({ line, question, expected: expected || null, page: pageMatch ? Number(pageMatch[1]) : null, ...(keywords.length ? { keywords } : {}) });
  });
  if (!rows.length && !errors.length) errors.push('질문이 한 줄도 없습니다.');
  if (rows.length > RAG_EVAL_MAX_QUESTIONS) errors.push(`한 번에 ${RAG_EVAL_MAX_QUESTIONS}개까지 평가합니다(지금 ${rows.length}개).`);
  return errors.length ? { ok: false, errors: errors.slice(0, 20) } : { ok: true, rows };
}

/** 문서 이름 비교용 — 확장자·공백·대소문자를 무시한다 */
export function titleKey(title: string): string {
  return clean(title).replace(/\.[a-z0-9]{1,5}$/i, '').replace(/\s+/g, '').toLowerCase();
}

/** 조각의 문서 이름이 기대 문서를 품는가(기대 문서는 이름의 일부만 적어도 된다) */
export function matchesExpected(title: string | undefined, expected: string): boolean {
  const want = titleKey(expected);
  return Boolean(want) && titleKey(title ?? '').includes(want);
}

/** 질문 하나의 판정 — `chunks`는 찾은 순서(위가 먼저), null이면 찾기 실패 */
export function scoreRagEvalRow(row: RagEvalRow, chunks: RagEvalChunk[] | null): RagEvalResult {
  const base = { line: row.line, question: row.question, expected: row.expected, page: row.page, ...(row.keywords?.length ? { keywords: row.keywords } : {}) };
  if (!chunks) return { ...base, verdict: 'error', rank: null, pageMatch: null, chunkCount: 0, topSimilarity: null, topDocuments: [] };
  const topDocuments: string[] = [];
  for (const c of chunks) {
    const name = clean(c.documentTitle) || '(이름 없음)';
    const t = c.scope === 'common' ? `[공통] ${name}` : name;
    if (!topDocuments.includes(t)) topDocuments.push(t);
    if (topDocuments.length >= 3) break;
  }
  const topSimilarity = chunks.length ? Math.max(...chunks.map((c) => (Number.isFinite(c.similarity) ? c.similarity : 0))) : null;
  const common = { chunkCount: chunks.length, topSimilarity, topDocuments, ...(chunks.some((c) => c.scope === 'common') ? { commonEvidence: true as const } : {}) };
  if (!row.expected) {
    return { ...base, ...common, verdict: chunks.length ? 'false_evidence' : 'correct_empty', rank: null, pageMatch: null };
  }
  if (!chunks.length) return { ...base, ...common, verdict: 'no_evidence', rank: null, pageMatch: row.page === null ? null : false };
  const index = chunks.findIndex((c) => matchesExpected(c.documentTitle, row.expected!));
  if (index === -1) return { ...base, ...common, verdict: 'miss', rank: null, pageMatch: row.page === null ? null : false };
  const pageMatch = row.page === null ? null : chunks.some((c) => matchesExpected(c.documentTitle, row.expected!) && c.page === row.page);
  return { ...base, ...common, verdict: 'hit', rank: index + 1, pageMatch };
}

const rate = (n: number, d: number) => (d ? Math.round((n / d) * 1000) / 1000 : null);

export function summarizeRagEval(results: RagEvalResult[], searchScope: RagEvalScope = 'chat'): RagEvalSummary {
  const counts: Record<RagEvalVerdict, number> = { hit: 0, miss: 0, no_evidence: 0, correct_empty: 0, false_evidence: 0, error: 0 };
  for (const r of results) counts[r.verdict] += 1;
  const scored = results.filter((r) => r.verdict !== 'error');
  const expectedRows = scored.filter((r) => r.expected);
  const pageRows = expectedRows.filter((r) => r.page !== null);
  const offTopicRows = scored.filter((r) => !r.expected);
  const mrr = expectedRows.length ? Math.round((expectedRows.reduce((s, r) => s + (r.rank ? 1 / r.rank : 0), 0) / expectedRows.length) * 1000) / 1000 : null;
  return {
    questions: results.length,
    expected: expectedRows.length,
    hits: counts.hit,
    hitRate: rate(counts.hit, expectedRows.length),
    withPage: pageRows.length,
    pageHits: pageRows.filter((r) => r.pageMatch).length,
    pageHitRate: rate(pageRows.filter((r) => r.pageMatch).length, pageRows.length),
    mrr,
    offTopic: offTopicRows.length,
    offTopicRejected: counts.correct_empty,
    offTopicRejectRate: rate(counts.correct_empty, offTopicRows.length),
    errors: counts.error,
    counts,
    searchScope,
    commonEvidenceQuestions: scored.filter((r) => r.commonEvidence).length,
  };
}

/** 두 실행의 찾은 범위가 다르면 비교 옆에 보일 안내 — 공통 자료실을 찾기 시작한 뒤와 전을 같은 규칙으로 오해하지 않게 */
export function scopeChangeNote(previous: Pick<RagEvalSummary, 'searchScope'>, current: Pick<RagEvalSummary, 'searchScope'>): string | null {
  const a = previous.searchScope ?? 'agent';
  const b = current.searchScope ?? 'agent';
  if (a === b) return null;
  return a === 'agent'
    ? '지난 평가는 비서 문서만 찾았고, 지금은 대화처럼 공통 자료실도 찾습니다 — 차이가 공통 자료 때문일 수 있습니다.'
    : '지난 평가는 공통 자료실도 찾았고, 이 평가는 비서 문서만 찾았습니다 — 차이가 공통 자료 때문일 수 있습니다.';
}

/**
 * 지난 실행의 결과에서 세트를 다시 만든다(탭 구분, 머리글 포함) — 같은 질문으로 다시 재기 위한 '세트 불러오기'.
 * `parseRagEvalSet`으로 다시 읽으면 같은 질문·기대 문서·기대 쪽이 나온다. 세트는 따로 저장하지 않는다(실행 기록이 세트를 품는다)
 */
// ── 같은 세트로 잰 다른 비서와 견주기(2026-11-12, 마이그레이션 없음) ──
// 세트는 기관 단위라(0059) 여러 비서를 같은 세트로 잴 수 있는데, 기록은 비서마다 따로 보여 어느 비서가 나은지 보려면 오가야 했다.
// 질문·기대 문서·기대 쪽을 다듬어 이은 글의 지문으로 같은 세트를 알아본다(핵심어는 빼지 않고 넣는다 — 답변 판정이 달라지므로).

/** 세트 지문 — 순서까지 같은 질문·기대 문서·기대 쪽·핵심어. FNV-1a 두 겹(64비트 남짓)이라 아무것도 가져오지 않는다(화면도 읽는다) */
export function ragEvalSetKey(rows: Array<Pick<RagEvalResult, 'question' | 'expected' | 'page'> & { keywords?: string[] }>): string {
  const text = rows.map((r) => [clean(r.question).toLowerCase(), clean(r.expected ?? '').toLowerCase(), r.page ?? '', (r.keywords ?? []).map((k) => clean(k)).join(';')].join('\u0001')).join('\u0002');
  let a = 0x811c9dc5; let b = 0x01000193 ^ 0x9e3779b9;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    a = Math.imul(a ^ c, 0x01000193) >>> 0;
    b = Math.imul(b ^ c, 0x01000193 ^ 0x5bd1e995) >>> 0;
  }
  return `v1:${rows.length}:${a.toString(16).padStart(8, '0')}${b.toString(16).padStart(8, '0')}`;
}

export interface AcrossRunRow {
  id: string;
  agent_id: string;
  agent_version: number;
  created_at: string;
  summary: RagEvalSummary;
  /** 지문이 없는 옛 기록만 결과를 함께 읽어 지문을 다시 센다 */
  results?: RagEvalResult[] | null;
}

export interface AcrossEntry { runId: string; agentId: string; agentName: string; agentVersion: number; createdAt: string; summary: RagEvalSummary; current: boolean }

/** 같은 지문의 실행 중 비서마다 가장 최근 것 — 기준 실행의 비서는 기준 실행 그대로. 찾음 비율·평균 순위 점수 순 */
export function pickAcrossAgents(base: AcrossRunRow, key: string, runs: AcrossRunRow[], names: Map<string, string>): AcrossEntry[] {
  const keyOf = (r: AcrossRunRow) => r.summary?.setKey ?? (r.results?.length ? ragEvalSetKey(r.results) : null);
  const latest = new Map<string, AcrossRunRow>([[base.agent_id, base]]);
  for (const r of runs) {
    if (r.agent_id === base.agent_id || keyOf(r) !== key || !names.has(r.agent_id)) continue;
    const seen = latest.get(r.agent_id);
    if (!seen || seen.created_at < r.created_at) latest.set(r.agent_id, r);
  }
  const score = (s: RagEvalSummary) => [s.hitRate ?? -1, s.mrr ?? -1, s.offTopicRejectRate ?? -1];
  return [...latest.values()]
    .map((r) => ({ runId: r.id, agentId: r.agent_id, agentName: names.get(r.agent_id) ?? '', agentVersion: r.agent_version, createdAt: r.created_at, summary: r.summary, current: r.id === base.id }))
    .sort((x, y) => {
      const [a, b] = [score(x.summary), score(y.summary)];
      return b[0] - a[0] || b[1] - a[1] || b[2] - a[2] || x.agentName.localeCompare(y.agentName, 'ko');
    });
}

export function ragEvalSetText(results: Array<Pick<RagEvalResult, 'question' | 'expected' | 'page'> & { keywords?: string[] }>): string {
  const cell = (v: string) => (/["\t\r\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v);
  // 핵심어를 적은 줄이 있을 때만 넷째 칸을 둔다(옛 세트는 그대로 세 칸)
  const withKeywords = results.some((r) => r.keywords?.length);
  const lines = results.map((r) => [cell(r.question), cell(r.expected ?? ''), r.page === null ? '' : String(r.page), ...(withKeywords ? [cell((r.keywords ?? []).join('; '))] : [])].join('\t'));
  return [withKeywords ? '질문\t기대 문서\t기대 쪽\t기대 답 핵심어' : '질문\t기대 문서\t기대 쪽', ...lines].join('\n');
}

/** 맞은 판정인가 — 비교에서 좋아짐·나빠짐을 가른다 */
const passed = (v: RagEvalVerdict) => v === 'hit' || v === 'correct_empty';

/** 지난 실행과 비교 — 같은 질문(공백·대소문자 무시)끼리. 판정 실패(error)는 어느 쪽이든 비교하지 않는다 */
export function compareRagEvalRuns(previous: RagEvalResult[], current: RagEvalResult[]): { improved: RagEvalResult[]; regressed: RagEvalResult[]; unmatched: number } {
  const key = (q: string) => clean(q).toLowerCase();
  const before = new Map(previous.map((r) => [key(r.question), r]));
  const improved: RagEvalResult[] = [];
  const regressed: RagEvalResult[] = [];
  let unmatched = 0;
  for (const r of current) {
    const p = before.get(key(r.question));
    if (!p) { unmatched += 1; continue; }
    if (p.verdict === 'error' || r.verdict === 'error') continue;
    if (!passed(p.verdict) && passed(r.verdict)) improved.push(r);
    if (passed(p.verdict) && !passed(r.verdict)) regressed.push(r);
  }
  return { improved, regressed, unmatched };
}

export const RAG_EVAL_VERDICT_LABELS: Record<RagEvalVerdict, string> = {
  hit: '찾음', miss: '다른 문서만', no_evidence: '근거 없음', correct_empty: '걸러짐(맞음)', false_evidence: '엉뚱한 근거', error: '찾기 실패',
};

export const RAG_EVAL_ANSWER_LABELS: Record<RagEvalAnswerVerdict, string> = {
  grounded: '기대 문서 인용', wrong_citation: '다른 문서 인용', no_citation: '인용 없음', declined: '찾지 못함이라 답함',
  correct_decline: '문서 인용 안 함(맞음)', false_answer: '엉뚱한 문서 인용', error: '답 만들기 실패',
};

/** 답변 판정 한 줄 — 화면 표와 CSV가 함께 쓴다(숫자·핵심어·없는 번호까지) */
export function answerNote(a: RagEvalAnswer): string {
  const parts = [RAG_EVAL_ANSWER_LABELS[a.verdict]];
  if (a.error) parts.push(a.error);
  if (a.unverifiedNumbers.length) parts.push(`확인 안 된 숫자 ${a.unverifiedNumbers.join(', ')}`);
  if (a.keywordsMissing?.length) parts.push(`빠진 핵심어 ${a.keywordsMissing.join(', ')}`);
  if (a.unknownRefs) parts.push(`없는 근거 번호 ${a.unknownRefs}개`);
  return parts.join(' · ');
}

/** 결과를 CSV로(엑셀에서 열리게 BOM) — 화면 내려받기용 */
export function ragEvalCsv(results: RagEvalResult[]): string {
  const cell = (v: unknown) => {
    const s = v === null || v === undefined ? '' : String(v);
    const safe = /^[=+\-@\t\r]/.test(s) ? `'${s}` : s; // 수식 주입 막기
    return /[",\n]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
  };
  // 답변까지 평가한 실행만 답 칸을 더한다(옛 CSV는 그대로)
  const withAnswers = results.some((r) => r.answer);
  // AI 채점을 한 실행만 채점 두 칸을 더한다(2026-11-09)
  const withJudge = results.some((r) => r.answer?.judge);
  // 사람 판정을 남긴 실행만 한 칸 더(2026-11-09)
  const withHuman = results.some((r) => r.answer?.human);
  // 도구를 쓰는 답으로 만든 실행만 한 칸 더(2026-11-09)
  const withTools = results.some((r) => typeof r.answer?.toolCalls === 'number');
  const head = ['줄', '질문', '기대 문서', '기대 쪽', '판정', '순위', '쪽 맞음', '근거 수', '최고 유사도', '상위 문서', ...(withAnswers ? ['기대 답 핵심어', '답변 판정', '답변 맞음', '인용한 문서', '답변'] : []), ...(withJudge ? ['AI 채점(참고)', 'AI 채점 이유'] : []), ...(withHuman ? ['사람 판정'] : []), ...(withTools ? ['부른 도구'] : [])];
  const lines = results.map((r) => [
    r.line, r.question, r.expected, r.page, RAG_EVAL_VERDICT_LABELS[r.verdict], r.rank, r.pageMatch === null ? '' : r.pageMatch ? '예' : '아니오', r.chunkCount, r.topSimilarity === null ? '' : r.topSimilarity.toFixed(3), r.topDocuments.join(' · '),
    ...(withAnswers ? [(r.keywords ?? []).join('; '), r.answer ? answerNote(r.answer) : '', r.answer ? (r.answer.passed ? '예' : '아니오') : '', r.answer?.cited.join(' · ') ?? '', r.answer?.text ?? ''] : []),
    ...(withJudge ? [r.answer?.judge ? judgeNote(r.answer.judge) : '', r.answer?.judge?.reason ?? ''] : []),
    ...(withHuman ? [r.answer?.human ? RAG_EVAL_JUDGE_LABELS[r.answer.human.grade] ?? '' : ''] : []),
    ...(withTools ? [typeof r.answer?.toolCalls === 'number' ? (r.answer.toolCalls ? `${(r.answer.toolsUsed ?? []).join(' · ')} (${r.answer.toolCalls}번)` : '없음') : ''] : []),
  ].map(cell).join(','));
  return `﻿${[head.join(','), ...lines].join('\n')}`;
}
