// src/lib/forbidden-match.ts
// 금지어 맞추기 규칙 한 곳(2026-11-06) — 아무것도 import하지 않는다(대화 입력 필터 filter.ts와 금지어 도우미 forbidden-words.ts가 함께 쓴다).
// 예전 두 곳 모두 `\b금지어\b`로 찾아 **한글 금지어를 한 번도 잡지 못했고**(`\b`는 영문·숫자 경계만 안다),
// 금지어의 특수 글자(`c++`)가 정규식을 깨 검사가 멈췄다.

/**
 * 보이지 않는 서식 글자(폭 없는 공백 U+200B·BOM·방향 제어 등 `\p{Cf}`)를 뺀다(2026-11-18) — 맞춰 볼 때만 쓴다(저장된 글은 그대로).
 * 금지어·주민등록번호 사이에 이런 글자를 끼우면 화면에는 그대로 보이는데 검사에는 걸리지 않았고,
 * 붙여 넣은 금지어에 딸려 온 글자 하나 때문에 그 금지어가 영영 걸리지 않았다(관리자는 막았다고 믿는다).
 */
export function stripInvisible(text: string): string {
  return text.replace(/\p{Cf}/gu, '');
}

export const FORBIDDEN_WORD_MIN = 2;
export const FORBIDDEN_WORD_MAX = 50;
export const FORBIDDEN_CONTEXT_MAX = 200;
/** 한 부서에 둘 수 있는 금지어 수 — 대화마다 그 부서와 상위 부서의 금지어를 모두 읽어 맞춘다 */
export const FORBIDDEN_WORDS_PER_DEPARTMENT = 300;

/**
 * 저장할 금지어 다듬기 — NFC, 제어·보이지 않는 글자 빼기, 공백 하나로.
 * **한 글자 금지어는 받지 않는다**: 한글 금지어는 '들어 있으면' 걸리므로 '개' 하나가 '개요'·'개선'이 든 질문을 모두 막는다
 * (하위 부서 직원까지). 오타 하나로 부서 전체의 대화가 막히는 것을 저장에서 붙잡는다.
 */
export function cleanForbiddenWord(raw: unknown): { ok: true; word: string } | { ok: false; message: string } {
  if (typeof raw !== 'string') return { ok: false, message: '금지어는 필수 입력 항목입니다.' };
  const word = stripInvisible(raw.normalize('NFC')).replace(/\p{Cc}/gu, ' ').replace(/\s+/g, ' ').trim();
  if (!word) return { ok: false, message: '금지어는 필수 입력 항목입니다.' };
  if ([...word].length < FORBIDDEN_WORD_MIN) {
    return { ok: false, message: `금지어는 ${FORBIDDEN_WORD_MIN}자 이상이어야 합니다. 한 글자는 그 글자가 든 질문을 모두 막습니다.` };
  }
  if ([...word].length > FORBIDDEN_WORD_MAX) {
    return { ok: false, message: `금지어는 ${FORBIDDEN_WORD_MAX}자 이내로 입력해 주세요.` };
  }
  return { ok: true, word };
}

/** 금지어 설명(왜 막는지) 다듬기 — 없으면 null */
export function cleanForbiddenContext(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const text = stripInvisible(raw.normalize('NFC')).replace(/\p{Cc}/gu, ' ').replace(/\s+/g, ' ').trim();
  return text ? text.slice(0, FORBIDDEN_CONTEXT_MAX) : null;
}

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
  const w = stripInvisible(word.normalize('NFC')).trim();
  if (!w) return false;
  const t = stripInvisible(text.normalize('NFC'));
  if (/^[A-Za-z0-9_\s]+$/.test(w)) return new RegExp(`(?<![A-Za-z0-9_])${escapeRegExp(w)}(?![A-Za-z0-9_])`, 'i').test(t);
  return t.toLocaleLowerCase('ko-KR').includes(w.toLocaleLowerCase('ko-KR'));
}
