import type { RetrievedChunk } from '@/lib/db';
import { sourceLocationLabel, sourceTitleLabel } from '@/components/chat/source-label';
import { checkNumbers, numbersIn, numberSpans } from './number-check';

/**
 * 숫자 근거 다시 찾기(2026-11-08, '검증 후 자동 재검색'의 첫 단계) — 문서 근거로 답한 턴에서 숫자 확인이 '확인되지 않음'으로 남긴 숫자를,
 * 그 숫자가 든 답변 문장으로 같은 문서 찾기(대화와 똑같은 `searchLikeChat` — 같은 보관함·공통 자료실·판 규칙·섞임/고아 거르기)를
 * 한 번 더 돌려 **다시 찾은 근거 글에 그 숫자가 있으면** '다시 찾은 근거에서 확인'으로 옮긴다.
 *
 * - 답변은 고치지 않는다(숫자 확인과 같은 원칙) — 모델은 그 근거를 보지 않고 답했으니 다시 찾은 근거는 따로 보이고 답변 근거 목록에 섞지 않는다.
 * - 모델을 부르지 않는다(사용량 없음). 문장마다 NODA `/context` 한 번, 문장 3개까지, 전체 5초까지만 기다린다 — 늦으면 그대로 '확인되지 않음'.
 * - 찾기가 실패하거나 근거에 그 숫자가 없으면 지금처럼 '확인되지 않음'.
 */
export const RESEARCH_MAX_QUERIES = 3;
export const RESEARCH_BUDGET_MS = 5_000;
export const RESEARCH_QUERY_MAX_CHARS = 200;
/** 저장·화면에 싣는 출처 글의 길이 상한 */
export const RESEARCH_SOURCE_MAX_CHARS = 80;
/** 뜻이 서기에 너무 짧은 문장(숫자·기호를 뺀 글자 수)은 찾지 않는다 — 숫자 하나로는 엉뚱한 근거가 온다 */
const MIN_QUERY_LETTERS = 6;

export type RecheckedNumber = { value: string; source: string };
export type NumberResearch = { unverified: string[]; rechecked: RecheckedNumber[]; searched: number; failed: number; timedOut: boolean };

/** 화면 안내 — 확인되지 않은 숫자 안내와 따로 보인다 */
export const NUMBER_RECHECK_NOTE = (list: RecheckedNumber[]): string =>
  `답변 근거에는 없었지만 문서를 다시 찾아 확인한 숫자: ${list.map((r) => `${r.value}(${r.source})`).join(' · ')} — 해당 문서에서 맥락을 확인하세요`;

/** 숫자가 든 문장 — 줄 안에서 문장 끝(마침표·물음표·느낌표 뒤 공백 또는 줄 끝)으로 자르고, 길면 숫자 앞뒤로 자른다 */
export function sentenceAround(text: string, start: number, end: number): string {
  const lineStart = text.lastIndexOf('\n', start - 1) + 1;
  const lineEndRaw = text.indexOf('\n', end);
  const lineEnd = lineEndRaw === -1 ? text.length : lineEndRaw;
  const line = text.slice(lineStart, lineEnd);
  const at = start - lineStart; const atEnd = end - lineStart;
  let s = 0; let e = line.length;
  const boundary = /[.!?。](?=\s|$)/g;
  let m: RegExpExecArray | null;
  while ((m = boundary.exec(line))) {
    const cut = m.index + 1;
    if (cut <= at) s = cut;
    else if (m.index >= atEnd) { e = cut; break; }
  }
  let sentence = line.slice(s, e);
  let numberAt = at - s;
  if (sentence.length > RESEARCH_QUERY_MAX_CHARS) {
    const half = Math.floor(RESEARCH_QUERY_MAX_CHARS / 2);
    const from = Math.max(0, Math.min(numberAt - half, sentence.length - RESEARCH_QUERY_MAX_CHARS));
    sentence = sentence.slice(from, from + RESEARCH_QUERY_MAX_CHARS);
    numberAt -= from;
  }
  return sentence
    .replace(/\[\d{1,3}\]/g, '')             // 인용 번호
    .replace(/[*_`~]+/g, '')                  // 강조 기호(낱말 사이에 끼므로 지운다)
    .replace(/[#>|]+/g, ' ')                  // 제목·인용·표 기호
    .replace(/^\s*[-•○●]\s+/, ' ')            // 글머리
    .replace(/\s+/g, ' ')
    .trim();
}

/** 확인되지 않은 숫자마다 그 숫자가 처음 나온 문장 — 같은 문장은 한 번만, 문장 3개까지 */
export function researchQueries(answer: string, unverified: string[]): { query: string; values: string[] }[] {
  const wanted = new Set(unverified);
  const out: { query: string; values: string[] }[] = [];
  const seen = new Set<string>();
  for (const span of numberSpans(answer)) {
    if (!wanted.has(span.raw) || seen.has(span.raw)) continue;
    seen.add(span.raw);
    const query = sentenceAround(answer, span.start, span.end);
    if (query.replace(/[\d\s.,%()△▲\-+]/g, '').length < MIN_QUERY_LETTERS) continue;
    const same = out.find((q) => q.query === query);
    if (same) { same.values.push(span.raw); continue; }
    if (out.length >= RESEARCH_MAX_QUERIES) continue;
    out.push({ query, values: [span.raw] });
  }
  return out;
}

function sourceOf(chunk: RetrievedChunk): string {
  const title = sourceTitleLabel(chunk);
  const location = typeof chunk.page === 'number' || chunk.cellRange || chunk.section ? sourceLocationLabel(chunk) : '';
  const label = location ? `${title} ${location}` : title;
  return label.length > RESEARCH_SOURCE_MAX_CHARS ? `${label.slice(0, RESEARCH_SOURCE_MAX_CHARS - 1)}…` : label;
}

/** 다시 찾은 근거 중 그 숫자가 든 첫 조각 */
function confirming(value: string, chunks: RetrievedChunk[]): RetrievedChunk | null {
  for (const chunk of chunks) {
    if (typeof chunk.text !== 'string' || !chunk.text) continue;
    if (checkNumbers(value, numbersIn(chunk.text)).length === 0) return chunk;
  }
  return null;
}

/**
 * 문장마다 찾기를 동시에 — 공유 시간 예산(기본 5초) 안에서. 결과는 문장 순서대로: 근거 조각, 실패·예외는 null, 시간 초과는 'timeout'.
 * 숫자 근거 다시 찾기와 '근거로 고쳐 쓰기'(answer-revise.ts)가 함께 쓴다
 */
export async function searchQueries(
  queries: { query: string }[],
  search: (query: string) => Promise<RetrievedChunk[] | null>,
  budgetMs: number = RESEARCH_BUDGET_MS
): Promise<(RetrievedChunk[] | null | 'timeout')[]> {
  if (!queries.length) return [];
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<'timeout'>((resolve) => { timer = setTimeout(() => resolve('timeout'), budgetMs); });
  try {
    return await Promise.all(queries.map((q) => Promise.race([
      Promise.resolve().then(() => search(q.query)).then((chunks) => chunks, () => null),
      timeout,
    ])));
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export async function researchNumbers(input: {
  answer: string;
  unverified: string[];
  search: (query: string) => Promise<RetrievedChunk[] | null>;
  budgetMs?: number;
}): Promise<NumberResearch> {
  const queries = researchQueries(input.answer, input.unverified);
  if (!queries.length) return { unverified: input.unverified, rechecked: [], searched: 0, failed: 0, timedOut: false };
  const results = await searchQueries(queries, input.search, input.budgetMs);
  const confirmed = new Map<string, string>();
  let failed = 0; let timedOut = false;
  results.forEach((result, i) => {
    if (result === 'timeout') { timedOut = true; return; }
    if (result === null) { failed++; return; }
    for (const value of queries[i].values) {
      const chunk = confirming(value, result);
      if (chunk) confirmed.set(value, sourceOf(chunk));
    }
  });
  return {
    unverified: input.unverified.filter((v) => !confirmed.has(v)),
    rechecked: input.unverified.filter((v) => confirmed.has(v)).map((value) => ({ value, source: confirmed.get(value)! })),
    searched: queries.length, failed, timedOut,
  };
}

/** 저장·`done`에서 온 값을 화면이 믿지 않고 다시 읽는다 — 꼴이 맞는 것만, 10개까지 */
export function readRechecked(raw: unknown): RecheckedNumber[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((r): r is RecheckedNumber => !!r && typeof r === 'object' && typeof (r as RecheckedNumber).value === 'string' && typeof (r as RecheckedNumber).source === 'string')
    .slice(0, 10)
    .map((r) => ({ value: r.value.slice(0, 40), source: r.source.slice(0, RESEARCH_SOURCE_MAX_CHARS) }));
}
