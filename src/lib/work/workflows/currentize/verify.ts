// src/lib/work/workflows/currentize/verify.ts
// 현행화 — 모델이 낸 문장 고치기를 근거·숫자·프로그램 소유 표지로 다시 확인한다. 순수 함수.
// 원칙: 근거가 없거나 프로그램이 정하는 값(숫자·조문 번호·연도)을 건드린 고치기는 그대로 넣지 않고 제안으로 내린다.
import type { RawRewrite, RewriteInput } from './model';

/** 절대 오차 — 큰 금액에서 1 차이가 통과하지 않게 상대 오차를 쓰지 않는다 */
const NUMBER_TOLERANCE = 1e-9;
const ARTICLE_REF = /제\d+조(?:의\d+)?/g;
const YEAR_REF = /(?:19|20)\d{2}년/g;

/** 쉼표를 3자리마다 낀 숫자 덩어리 또는 일반 숫자(소수 포함). 작은 정수·연도·월·일도 모두 잡는다 */
const DIGIT_RUN = /\d{1,3}(?:,\d{3})+(?:\.\d+)?|\d+(?:\.\d+)?/g;

/** 나온 순서 그대로(같은 표지의 자리 바꿈·중복 삭제도 잡으려고 집합이 아니라 배열로 비교한다) */
function tokenList(text: string, re: RegExp): string[] {
  return text.normalize('NFC').match(re) ?? [];
}

function sameList(a: string[], b: string[]): boolean {
  return a.length === b.length && a.every((x, i) => x === b[i]);
}

function digitValues(text: string): number[] {
  return (text.normalize('NFC').match(DIGIT_RUN) ?? []).map((d) => Number(d.replace(/,/g, ''))).filter(Number.isFinite);
}

/** 근거(basis)가 하나 이상이고 전부 입력이 인정하는 것인가 */
function basisOk(basis: string[], input: RewriteInput): boolean {
  if (basis.length === 0) return false;
  const sourceIds = new Set(input.sources.map((s) => s.id));
  // 프롬프트에 실린 인용(바뀜 + 현재 조문 있음)만 근거다
  const changedIds = new Set(input.citations.filter((c) => c.status === 'changed' && c.current !== null).map((c) => c.segmentId));
  const hasMemo = input.memo.trim() !== '';
  return basis.every((b) => (b === 'memo' ? hasMemo : sourceIds.has(b) || changedIds.has(b)));
}

/**
 * 고친 글의 숫자가 전부 알려진 값이거나 원래 글에 있던 값인가.
 * 숫자 확인(number-check)처럼 작은 정수를 빼지 않는다 — '150명→250명'·'15%→50%'·'10월 3일→11월 9일'도 지어낸 값이다.
 * 제N조·N년 표지의 숫자는 아래에서 순서까지 따로 비교하므로 여기서는 뺀다.
 */
function numbersOk(original: string, rewritten: string, known: Set<number>): boolean {
  const allowed = [...known, ...digitValues(original)];
  const rest = rewritten.replace(ARTICLE_REF, ' ').replace(YEAR_REF, ' ');
  return digitValues(rest).every((v) => allowed.some((a) => Math.abs(a - v) <= NUMBER_TOLERANCE));
}

export function verifyRewrites(raw: RawRewrite[], input: RewriteInput, knownNumbers: Set<number>): { accepted: RawRewrite[]; proposed: RawRewrite[] } {
  const originals = new Map(input.segments.map((s) => [s.id, s.text]));
  const accepted: RawRewrite[] = [];
  const proposed: RawRewrite[] = [];
  for (const r of raw) {
    const original = originals.get(r.segmentId);
    const ok =
      original !== undefined &&
      basisOk(r.basis, input) &&
      numbersOk(original, r.text, knownNumbers) &&
      sameList(tokenList(original, ARTICLE_REF), tokenList(r.text, ARTICLE_REF)) &&
      sameList(tokenList(original, YEAR_REF), tokenList(r.text, YEAR_REF));
    (ok ? accepted : proposed).push(r);
  }
  return { accepted, proposed };
}
