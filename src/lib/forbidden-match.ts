// src/lib/forbidden-match.ts
// 금지어 맞추기 규칙 한 곳(2026-11-06) — 아무것도 import하지 않는다(대화 입력 필터 filter.ts와 금지어 도우미 forbidden-words.ts가 함께 쓴다).
// 예전 두 곳 모두 `\b금지어\b`로 찾아 **한글 금지어를 한 번도 잡지 못했고**(`\b`는 영문·숫자 경계만 안다),
// 금지어의 특수 글자(`c++`)가 정규식을 깨 검사가 멈췄다.

/** 정규식에 넣을 글자 그대로 — 금지어에 `+`·`(` 같은 글자가 있어도 깨지지 않게 */
export function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * 금지어가 글에 있는가.
 * - 영문·숫자·공백만인 금지어: 영문·숫자에 붙지 않은 자리만(대소문자 무시) — 'ass'가 'class'에 걸리지 않게
 * - 그 밖(한글이 든 금지어): 들어 있으면 — 한국어는 조사가 붙어('비밀을') 낱말 경계로 가를 수 없다
 */
export function containsForbiddenWord(text: string, word: string): boolean {
  const w = word.normalize('NFC').trim();
  if (!w) return false;
  const t = text.normalize('NFC');
  if (/^[A-Za-z0-9_\s]+$/.test(w)) return new RegExp(`(?<![A-Za-z0-9_])${escapeRegExp(w)}(?![A-Za-z0-9_])`, 'i').test(t);
  return t.toLocaleLowerCase('ko-KR').includes(w.toLocaleLowerCase('ko-KR'));
}
