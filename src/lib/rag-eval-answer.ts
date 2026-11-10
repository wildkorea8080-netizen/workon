// src/lib/rag-eval-answer.ts
// 문서 찾기 평가의 '답변까지 평가'(2026-11-08) — 순수 규칙. 화면과 라우트가 함께 쓴다(서버 모듈을 가져오지 않는다).
//
// 질문마다 대화와 같은 찾기·같은 시스템 프롬프트(비서 지시문 + 참고 자료·인용 규칙)로 답을 한 번 만들고, **프로그램이** 판정한다 —
// 판정에 AI 채점자를 쓰지 않는다(채점자도 틀릴 수 있고 비용이 두 배다). 'AI 채점도'(2026-11-09, rag-eval-judge.ts)는 고를 때만, 참고로 따로 적는다. 보는 것:
//  ① 답이 기대 문서를 [n]으로 인용했나(인용 번호 → 그 번호의 근거 조각 문서 이름)
//  ② 답의 숫자가 그 턴에 AI가 본 숫자(시스템 프롬프트·질문)에 있나 — 대화의 '숫자 확인'과 같은 규칙
//  ③ 사람이 적어 둔 '기대 답 핵심어'가 모두 들어 있나(선택)
//  ④ 엉뚱한 질문에는 문서를 인용하지 않았나
// 답이 맞는 말인지까지는 모른다 — 핵심어를 적어 두면 그만큼 더 본다.

import { checkNumbers } from '@/lib/assistant/number-check';
import { matchesExpected, type RagEvalResult } from '@/lib/rag-eval';
import { judgeAgreement, summarizeJudges, type RagEvalHumanLabel, type RagEvalJudge, type RagEvalJudgeAgreement, type RagEvalJudgeSummary } from '@/lib/rag-eval-judge';

/** 답변까지 평가할 때 한 번에 재는 질문 수 — 질문마다 모델을 한 번 부른다 */
export const RAG_EVAL_ANSWER_MAX_QUESTIONS = 20;
/** 기록에 남기는 답 글의 길이(근거 원문은 남기지 않고, 답은 사람이 판정 이유를 보도록 앞부분만) */
export const RAG_EVAL_ANSWER_TEXT_MAX = 1500;
/** 답 하나의 출력 상한 */
export const RAG_EVAL_ANSWER_MAX_TOKENS = 1500;

/**
 * grounded = 기대 문서를 인용함 · wrong_citation = 다른 문서만 인용 · no_citation = 인용 없이 답함 · declined = '찾지 못했다'고 답함 ·
 * correct_decline = 엉뚱한 질문에 문서를 인용하지 않음(맞음) · false_answer = 엉뚱한 질문에 문서를 인용함 · error = 답을 만들지 못함
 */
export type RagEvalAnswerVerdict = 'grounded' | 'wrong_citation' | 'no_citation' | 'declined' | 'correct_decline' | 'false_answer' | 'error';

export interface RagEvalAnswer {
  verdict: RagEvalAnswerVerdict;
  /** 판정이 맞고(grounded·correct_decline) 숫자·핵심어·인용 번호에 문제가 없음 */
  passed: boolean;
  /** 답 글 앞부분(RAG_EVAL_ANSWER_TEXT_MAX자) */
  text: string;
  /** 인용한 근거의 문서 이름(공통 자료는 '[공통] 이름', 중복 없이) */
  cited: string[];
  /** 근거 묶음에 없는 번호를 인용한 수 */
  unknownRefs: number;
  /** 본 숫자에서 못 찾은 답의 숫자(대화의 '숫자 확인'과 같은 규칙) */
  unverifiedNumbers: string[];
  /** 기대 답 핵심어 중 답에 없는 것 — 핵심어를 준 질문에만 칸이 있다 */
  keywordsMissing?: string[];
  model?: string;
  inputTokens?: number;
  outputTokens?: number;
  costKrw?: number;
  /** error일 때 사람이 읽을 이유 */
  error?: string;
  /** 'AI 채점도'를 고른 실행의 기대 문서 있는 질문에만(2026-11-09, rag-eval-judge.ts) — 참고, `passed`를 바꾸지 않는다 */
  judge?: RagEvalJudge;
  /** 도구를 쓰는 답(2026-11-09)으로 만든 실행에만 — 부른 도구 수와 이름(겹침 없이 10개). 도구 결과 숫자는 숫자 확인의 '본 숫자'에 들었다 */
  toolCalls?: number;
  toolsUsed?: string[];
  /** 관리자가 평가 뒤에 매긴 사람 판정(2026-11-09) — AI 채점과 맞대 채점자를 잰다. `passed`를 바꾸지 않는다 */
  human?: RagEvalHumanLabel;
}

export interface RagEvalAnswerSummary {
  /** 답을 만든 질문 수(만들지 못한 것 제외) / 못 만든 수 */
  evaluated: number;
  errors: number;
  passed: number;
  passRate: number | null;
  /** 기대 문서가 있는 질문 중 답이 기대 문서를 인용한 수 */
  expected: number;
  grounded: number;
  groundedRate: number | null;
  /** 확인되지 않은 숫자가 있는 답 수 */
  numberIssues: number;
  /** 핵심어를 준 질문 수 / 그중 모두 들어 있던 수 */
  keywordRows: number;
  keywordPasses: number;
  keywordRate: number | null;
  /** 엉뚱한 질문 수 / 그중 문서를 인용하지 않은 수 */
  offTopic: number;
  offTopicDeclined: number;
  offTopicDeclineRate: number | null;
  inputTokens: number;
  outputTokens: number;
  costKrw: number;
  models: string[];
  /** AI 채점을 한 실행에만 — 토큰·원가는 위 합계와 따로 센다 */
  judge?: RagEvalJudgeSummary;
  /** 도구를 쓰는 답으로 만든 실행에만 — 도구를 한 번이라도 부른 답 수 */
  toolAnswers?: number;
  /** 사람 판정이 있을 때만 — 사람 판정과 AI 채점 맞대기 */
  agreement?: RagEvalJudgeAgreement;
}

/** 근거 조각 중 인용 판정에 쓰는 것 — 대화의 `RetrievedChunk`와 같은 칸 */
export interface RagEvalAnswerChunk {
  n?: number;
  chunkIndex?: number;
  documentTitle?: string;
  scope?: 'common';
}

const cleanTitle = (c: RagEvalAnswerChunk) => {
  const name = (c.documentTitle ?? '').normalize('NFC').replace(/\s+/g, ' ').trim() || '(이름 없음)';
  return c.scope === 'common' ? `[공통] ${name}` : name;
};

/** 답 속 인용 번호 `[n]`(1~999, 중복 없이 나온 순서). 코드 조각 안의 것은 뺀다 */
export function citedNumbers(text: string): number[] {
  const plain = text.replace(/```[\s\S]*?```/g, ' ').replace(/`[^`\n]*`/g, ' ');
  const out: number[] = [];
  for (const m of plain.matchAll(/\[(\d{1,3})\]/g)) {
    const n = Number(m[1]);
    if (n >= 1 && !out.includes(n)) out.push(n);
  }
  return out;
}

/** '문서에서 찾지 못했습니다' 꼴의 답인가 — 인용 규칙이 시키는 문구와 그 변형 */
export function saysNotFound(text: string): boolean {
  return /찾(?:지|을\s*수)\s*(?:못|없)/.test(text) || /근거(?:가|를)?\s*(?:찾|확인할\s*수)\s*(?:없|못)/.test(text);
}

/** 핵심어 비교용 — 공백·대소문자 무시, 숫자 사이 쉼표 무시(1,200 = 1200) */
export function keywordKey(s: string): string {
  return s.normalize('NFC').toLowerCase().replace(/(\d),(?=\d{3})/g, '$1').replace(/\s+/g, '');
}

export function missingKeywords(answer: string, keywords: string[]): string[] {
  const text = keywordKey(answer);
  return keywords.filter((k) => !text.includes(keywordKey(k)));
}

/**
 * 답 하나의 판정. `chunks`는 그 질문의 근거(대화와 같은 번호), `shown`은 그 턴에 AI가 본 숫자(시스템 프롬프트·질문).
 * 기대 문서가 있는 질문: 기대 문서 인용 → grounded, 다른 문서만 인용 → wrong_citation, 인용 없이 '찾지 못했다' → declined, 그 밖 → no_citation.
 * 엉뚱한 질문: 근거 묶음의 문서를 하나라도 인용 → false_answer, 아니면 correct_decline
 */
export function scoreAnswer(
  row: { expected: string | null; keywords?: string[] },
  chunks: RagEvalAnswerChunk[],
  answer: string,
  shown: number[]
): RagEvalAnswer {
  const byNumber = new Map<number, RagEvalAnswerChunk>();
  chunks.forEach((c, i) => {
    const n = typeof c.n === 'number' ? c.n : (typeof c.chunkIndex === 'number' ? c.chunkIndex + 1 : i + 1);
    if (!byNumber.has(n)) byNumber.set(n, c);
  });
  const refs = citedNumbers(answer);
  const citedChunks = refs.map((n) => byNumber.get(n)).filter((c): c is RagEvalAnswerChunk => Boolean(c));
  const cited: string[] = [];
  for (const c of citedChunks) { const t = cleanTitle(c); if (!cited.includes(t)) cited.push(t); }
  const unknownRefs = refs.length - citedChunks.length;
  const unverifiedNumbers = checkNumbers(answer, shown);
  const keywordsMissing = row.keywords?.length ? missingKeywords(answer, row.keywords) : undefined;

  let verdict: RagEvalAnswerVerdict;
  if (row.expected) {
    if (citedChunks.some((c) => matchesExpected(c.documentTitle, row.expected!))) verdict = 'grounded';
    else if (citedChunks.length) verdict = 'wrong_citation';
    else if (saysNotFound(answer)) verdict = 'declined';
    else verdict = 'no_citation';
  } else {
    verdict = citedChunks.length ? 'false_answer' : 'correct_decline';
  }
  const passed = (verdict === 'grounded' || verdict === 'correct_decline')
    && unknownRefs === 0 && unverifiedNumbers.length === 0 && !(keywordsMissing?.length);
  return {
    verdict, passed, text: answer.slice(0, RAG_EVAL_ANSWER_TEXT_MAX), cited, unknownRefs, unverifiedNumbers,
    ...(keywordsMissing ? { keywordsMissing } : {}),
  };
}

export function answerError(message: string): RagEvalAnswer {
  return { verdict: 'error', passed: false, text: '', cited: [], unknownRefs: 0, unverifiedNumbers: [], error: message };
}

const rate = (n: number, d: number) => (d ? Math.round((n / d) * 1000) / 1000 : null);

/** 답변 요약 — 답변까지 평가한 실행이 아니면(답 칸이 하나도 없으면) undefined */
export function summarizeAnswers(results: Array<Pick<RagEvalResult, 'expected' | 'keywords' | 'answer'>>): RagEvalAnswerSummary | undefined {
  const rows = results.filter((r) => r.answer);
  if (!rows.length) return undefined;
  const done = rows.filter((r) => r.answer!.verdict !== 'error');
  const expectedRows = done.filter((r) => r.expected);
  const keywordRows = done.filter((r) => r.answer!.keywordsMissing);
  const offTopic = done.filter((r) => !r.expected);
  const sum = (f: (a: RagEvalAnswer) => number | undefined) => rows.reduce((s, r) => s + (f(r.answer!) ?? 0), 0);
  const models: string[] = [];
  for (const r of rows) if (r.answer!.model && !models.includes(r.answer!.model)) models.push(r.answer!.model);
  const passed = done.filter((r) => r.answer!.passed).length;
  const grounded = expectedRows.filter((r) => r.answer!.verdict === 'grounded').length;
  const keywordPasses = keywordRows.filter((r) => !r.answer!.keywordsMissing!.length).length;
  const offTopicDeclined = offTopic.filter((r) => r.answer!.verdict === 'correct_decline').length;
  const judge = summarizeJudges(rows.map((r) => r.answer!.judge));
  const agreement = judgeAgreement(rows.map((r) => r.answer));
  return {
    evaluated: done.length,
    errors: rows.length - done.length,
    passed,
    passRate: rate(passed, done.length),
    expected: expectedRows.length,
    grounded,
    groundedRate: rate(grounded, expectedRows.length),
    numberIssues: done.filter((r) => r.answer!.unverifiedNumbers.length).length,
    keywordRows: keywordRows.length,
    keywordPasses,
    keywordRate: rate(keywordPasses, keywordRows.length),
    offTopic: offTopic.length,
    offTopicDeclined,
    offTopicDeclineRate: rate(offTopicDeclined, offTopic.length),
    inputTokens: sum((a) => a.inputTokens),
    outputTokens: sum((a) => a.outputTokens),
    costKrw: Math.round(sum((a) => a.costKrw) * 100) / 100,
    models,
    ...(judge ? { judge } : {}),
    ...(agreement ? { agreement } : {}),
    ...(rows.some((r) => typeof r.answer!.toolCalls === 'number') ? { toolAnswers: rows.filter((r) => (r.answer!.toolCalls ?? 0) > 0).length } : {}),
  };
}

/** 답변이 지난 실행보다 좋아졌거나 나빠진 질문 — 같은 질문(공백·대소문자 무시)끼리, 어느 쪽이든 답을 못 만들었으면 비교하지 않는다 */
export function compareAnswers(previous: RagEvalResult[], current: RagEvalResult[]): { improved: RagEvalResult[]; regressed: RagEvalResult[] } {
  const key = (q: string) => q.normalize('NFC').replace(/\s+/g, ' ').trim().toLowerCase();
  const before = new Map(previous.map((r) => [key(r.question), r]));
  const improved: RagEvalResult[] = [];
  const regressed: RagEvalResult[] = [];
  for (const r of current) {
    const p = before.get(key(r.question));
    if (!p?.answer || !r.answer || p.answer.verdict === 'error' || r.answer.verdict === 'error') continue;
    if (!p.answer.passed && r.answer.passed) improved.push(r);
    if (p.answer.passed && !r.answer.passed) regressed.push(r);
  }
  return { improved, regressed };
}
