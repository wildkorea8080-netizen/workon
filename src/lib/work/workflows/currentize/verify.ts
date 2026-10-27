// src/lib/work/workflows/currentize/verify.ts
// 현행화 — 모델이 낸 문장 고치기를 근거·숫자·프로그램 소유 표지로 다시 확인한다. 순수 함수.
// 원칙: 근거가 없거나 프로그램이 정하는 값(숫자·조문 번호·연도)을 건드린 고치기는 그대로 넣지 않고 제안으로 내린다.
import { numberSpans } from '@/lib/assistant/number-check';
import type { RawRewrite, RewriteInput } from './model';

/** 절대 오차 — 큰 금액에서 1 차이가 통과하지 않게 상대 오차를 쓰지 않는다 */
const NUMBER_TOLERANCE = 1e-9;
const ARTICLE_REF = /제\d+조(?:의\d+)?/g;
const YEAR_REF = /(?:19|20)\d{2}년/g;

function tokenSet(text: string, re: RegExp): Set<string> {
  return new Set(text.normalize('NFC').match(re) ?? []);
}

function sameSet(a: Set<string>, b: Set<string>): boolean {
  if (a.size !== b.size) return false;
  for (const x of a) if (!b.has(x)) return false;
  return true;
}

/** 근거(basis)가 하나 이상이고 전부 입력이 인정하는 것인가 */
function basisOk(basis: string[], input: RewriteInput): boolean {
  if (basis.length === 0) return false;
  const sourceIds = new Set(input.sources.map((s) => s.id));
  const changedIds = new Set(input.citations.filter((c) => c.status === 'changed').map((c) => c.segmentId));
  const hasMemo = input.memo.trim() !== '';
  return basis.every((b) => (b === 'memo' ? hasMemo : sourceIds.has(b) || changedIds.has(b)));
}

/** 고친 글의 숫자가 전부 알려진 값이거나 원래 글에 있던 값인가 */
function numbersOk(original: string, rewritten: string, known: Set<number>): boolean {
  const allowed = [...known, ...numberSpans(original).map((n) => n.value)];
  return numberSpans(rewritten).every((n) => allowed.some((a) => Math.abs(a - n.value) <= NUMBER_TOLERANCE));
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
      sameSet(tokenSet(original, ARTICLE_REF), tokenSet(r.text, ARTICLE_REF)) &&
      sameSet(tokenSet(original, YEAR_REF), tokenSet(r.text, YEAR_REF));
    (ok ? accepted : proposed).push(r);
  }
  return { accepted, proposed };
}
