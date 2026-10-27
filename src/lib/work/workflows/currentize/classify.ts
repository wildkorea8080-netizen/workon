// src/lib/work/workflows/currentize/classify.ts
import { numberSpans } from '@/lib/assistant/number-check';

/**
 * 조각 한 문단의 글에서 현행화 때 바뀔 수 있는 자리를 찾는다(S6-1). 글만 보는 순수 함수 —
 * DB·모델·파일을 모른다. 연도·기간·수치·규정 인용·사람·날짜를 찾고, 그 밖의 줄글은 `prose` 하나로 둔다.
 *
 * 겹치면 우선순위(citation > date > number > year > person > period)가 높은 쪽만 남긴다.
 * 예) 「2025년 제정 조례」의 2025년은 연도가 아니라 인용의 일부이고, '2025. 1. 1.'은 연도가 아니라 날짜다.
 */
export type FindingKind = 'year' | 'period' | 'number' | 'citation' | 'person' | 'date' | 'prose';

export interface Finding {
  kind: FindingKind;
  start: number;
  end: number;
  text: string;
  detail?: { name?: string; article?: string };
}

export interface ClassifyContext {
  /** 기준일(YYYY-MM-DD). 분류 자체는 쓰지 않는다 — 뒤 단계와 같은 문맥을 넘기려고 받는다 */
  basisDate: string;
  /** 자료실에서 온 규정·지침 이름 */
  regulationNames: string[];
  personNames: string[];
}

/** 겹칠 때 앞선 것이 이긴다 */
const PRIORITY: FindingKind[] = ['citation', 'date', 'number', 'year', 'person', 'period', 'prose'];

const ARTICLE = String.raw`제\d+조(?:의\d+)?`;
const BRACKET_CITATION = new RegExp(String.raw`「([^」]+)」(?:\s*(${ARTICLE}))?`, 'g');
const DATE = /(?<!\d)\d{4}\.\s?\d{1,2}\.\s?\d{1,2}\./g;
// '부터'가 뒤따르는 연도('2025년부터 3년간')는 시점 표기가 아니라 기간의 시작이라 고치지 않는다
const NOT_FROM = String.raw`(?!\s*부터)`;
const YEAR_PATTERNS = [
  new RegExp(String.raw`(?<!\d)(?:19|20)\d\d년${NOT_FROM}`, 'g'),
  new RegExp(String.raw`['’‘]\d\d(?!\d)${NOT_FROM}`, 'g'),
  new RegExp(String.raw`(?<!\d)20\d\d\.\s?\d{1,2}\.${NOT_FROM}`, 'g'),
];
/** 문서번호 꼴 '2025-123호' — 연도처럼 보여도 번호다 */
const DOC_NUMBER = /(?<!\d)\d{4}-\d+호/g;
// 이름 바로 뒤에 붙는 조사·호칭(긴 것 먼저). 이 밖의 글자가 붙으면('홍길동순') 다른 낱말이다
const NAME_SUFFIX = '님께|께서|에게|으로|이가|이|가|은|는|을|를|의|도|과|와|께|씨|님|로';
const PERIOD = /전년도|금년도|당해연도|올해|작년/g;

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, String.raw`\$&`);
}

function overlaps(a: { start: number; end: number }, b: { start: number; end: number }): boolean {
  return a.start < b.end && a.end > b.start;
}

function collect(text: string, ctx: ClassifyContext): Finding[] {
  const out: Finding[] = [];
  const push = (kind: FindingKind, start: number, end: number, detail?: Finding['detail']) =>
    out.push({ kind, start, end, text: text.slice(start, end), ...(detail ? { detail } : {}) });

  // 인용 — 「…」는 목록과 상관없이, 목록의 이름은 글 속 그대로(긴 이름 먼저)
  for (const m of text.matchAll(BRACKET_CITATION)) {
    const start = m.index ?? 0;
    push('citation', start, start + m[0].length, { name: m[1], article: m[2] });
  }
  const names = [...new Set(ctx.regulationNames.map((n) => n.trim()).filter(Boolean))].sort((a, b) => b.length - a.length);
  if (names.length > 0) {
    const re = new RegExp(String.raw`(${names.map(escapeRegExp).join('|')})(?:\s*(${ARTICLE}))?`, 'g');
    for (const m of text.matchAll(re)) {
      const start = m.index ?? 0;
      push('citation', start, start + m[0].length, { name: m[1], article: m[2] });
    }
  }

  for (const m of text.matchAll(DATE)) push('date', m.index ?? 0, (m.index ?? 0) + m[0].length);

  // 수치 — number-check와 같은 기준(4자리 미만 정수·연도·날짜·id 제외). 단위는 줄글에 남기고 숫자 토큰만
  // 문서번호 '2025-1234호'의 일련번호는 값이 아니라 번호다 — 수치로도 연도로도 보지 않는다
  const docNumbers = [...text.matchAll(DOC_NUMBER)].map((m) => ({ start: m.index ?? 0, end: (m.index ?? 0) + m[0].length }));
  for (const n of numberSpans(text)) {
    if (docNumbers.some((d) => overlaps(n, d))) continue;
    push('number', n.start, n.end);
  }
  for (const re of YEAR_PATTERNS) {
    for (const m of text.matchAll(re)) {
      const span = { start: m.index ?? 0, end: (m.index ?? 0) + m[0].length };
      if (docNumbers.some((d) => overlaps(span, d))) continue;
      push('year', span.start, span.end);
    }
  }

  // 사람 — 같은 이름이 낱말이거나 조사·호칭만 붙었을 때(finding은 이름 부분만)
  for (const name of new Set(ctx.personNames.map((n) => n.trim()).filter(Boolean))) {
    const re = new RegExp(String.raw`(?<![가-힣A-Za-z0-9])${escapeRegExp(name)}(?=(?:${NAME_SUFFIX})?(?![가-힣A-Za-z0-9]))`, 'g');
    for (const m of text.matchAll(re)) push('person', m.index ?? 0, (m.index ?? 0) + m[0].length);
  }

  for (const m of text.matchAll(PERIOD)) push('period', m.index ?? 0, (m.index ?? 0) + m[0].length);
  return out;
}

export function classifySegment(text: string, ctx: ClassifyContext): Finding[] {
  if (!text) return [];
  const byPriority = collect(text, ctx).sort(
    (a, b) => PRIORITY.indexOf(a.kind) - PRIORITY.indexOf(b.kind) || a.start - b.start,
  );
  const kept: Finding[] = [];
  for (const f of byPriority) {
    if (!kept.some((k) => overlaps(f, k))) kept.push(f);
  }
  kept.sort((a, b) => a.start - b.start);
  if (kept.length === 0 && text.length >= 10) return [{ kind: 'prose', start: 0, end: text.length, text }];
  return kept;
}
