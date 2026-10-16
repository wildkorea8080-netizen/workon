/**
 * 채울 자리 규칙(설계 4.1). 표시({{이름}}) 찾기, 번호 제목 급, 자리 표시 글자, 표 항목명 다듬기.
 * 표시 경로(hwpx.ts·docx.ts)·자동 자리(hwpx-auto.ts)·대체 목차(fallback.ts)가 함께 쓴다 —
 * 기호·글자 판정은 이 파일 한 곳에만 둔다.
 */
export interface MarkerMatch {
  label: string;
  start: number;
  end: number;
}

const MARKER = /\{\{\s*([^{}\n]{1,60}?)\s*\}\}/g;

export function findMarkers(text: string): MarkerMatch[] {
  const out: MarkerMatch[] = [];
  MARKER.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = MARKER.exec(text))) {
    const label = m[1].trim();
    if (label) out.push({ label, start: m.index, end: m.index + m[0].length });
  }
  return out;
}

/**
 * 번호 제목 급(설계 4.1). 이 순서가 값이다 - 작을수록 위 급.
 * 문단 맨 앞(앞 공백 제외)의 기호로만 판정한다. 기호 목록은 이 파일 한 곳에만 둔다.
 */
const HEADING_SYMBOLS: ReadonlyArray<{ level: number; re: RegExp }> = [
  { level: 1, re: /^[Ⅰ-Ⅹ]\./ },
  // 1.5배의 '1.'은 번호가 아니고, '26. 3. 5.'처럼 뒤가 또 '숫자.'면 날짜다
  { level: 2, re: /^\d{1,2}\.(?!\d)(?!\s*\d+\.)/ },
  { level: 2, re: /^[□■]\s+/ }, // 기호 뒤 공백 필수: '□개요'·'□□□'는 제목이 아니다
  { level: 3, re: /^[가나다라마바사아자차카타파하]\./ },
  { level: 3, re: /^[○●]\s+/ },
  { level: 4, re: /^\d{1,2}\)/ },
  { level: 4, re: /^[-–]\s+/ }, // 하이픈은 뒤에 공백이 있을 때만 글머리
  { level: 5, re: /^[가나다라마바사아자차카타파하]\)/ },
  { level: 6, re: /^\(\d{1,2}\)/ },
  { level: 7, re: /^\([가나다라마바사아자차카타파하]\)/ },
  { level: 8, re: /^[①-⑳]/ },
  { level: 9, re: /^[㉮-㉻]/ },
];

const HEADING_MAX_CHARS = 40;
const SENTENCE_END = /(다|요|음|함)\.$/;

function matchSymbol(text: string): { level: number; rest: string } | null {
  const t = text.trimStart();
  for (const { level, re } of HEADING_SYMBOLS) {
    const m = re.exec(t);
    if (m) return { level, rest: t.slice(m[0].length).trim() };
  }
  return null;
}

/** 번호 제목이면 급(작을수록 위), 아니면 null. 앞 공백은 무시 */
export function headingLevel(text: string): number | null {
  const hit = matchSymbol(text);
  if (!hit) return null;
  const len = hit.rest.length;
  if (len < 1 || len > HEADING_MAX_CHARS) return null;
  // 기호뿐인 글(글자·숫자가 하나도 없음)은 제목이 아니라 빈 자리다
  if (!/[\p{L}\p{N}]/u.test(hit.rest)) return null;
  // 본문 글머리('○ 사업기간은 1년이다.')를 제목으로 잡지 않는다
  if (SENTENCE_END.test(hit.rest)) return null;
  return hit.level;
}

/** 개조식 글머리(○●-–). 본문 한 줄이지 영역을 여는 제목이 아니다 */
const BULLET = /^[○●\-–]\s+/;

/**
 * 영역을 여는 번호 제목의 급. headingLevel에서 개조식 글머리(○●-–)를 뺀 것이다.
 * 이미 쓴 보고서는 글머리마다 내용이 있다 — 글머리를 제목으로 보면 내용 줄 사이 빈 줄이
 * 자리가 되어 기존 글 사이에 끼워 넣는다. 자동 자리와 대체 목차가 이것을 쓴다
 */
export function numberedHeadingLevel(text: string): number | null {
  if (BULLET.test(text.trimStart())) return null;
  return headingLevel(text);
}

/** 자리 표시 글자: 같은 글자 3개 이상 반복(○○○·OOO·ㅇㅇㅇ)과 안내 문구. 글 전체가 이것일 때만 */
export const PLACEHOLDER_PATTERNS: readonly RegExp[] = [
  // 구분선(---, ===, ...)이나 값(111)을 빈 자리로 오인하지 않게 글자를 한정한다
  /^([○●□■OoㅇXx0])\1{2,}$/u,
  /^\((?:내용|작성|기재|입력|예시)\)$/,
  /^내용 입력$/,
  /^내용을 입력하세요\.?$/,
];

/** 비었거나 자리 표시 글자뿐인가(앞의 번호 기호는 떼고 본다) */
export function isPlaceholderText(text: string): boolean {
  const whole = text.trim();
  if (!whole) return true;
  // 기호를 뗀 글과 떼지 않은 글을 모두 본다: '○○○'은 기호 하나 뗀 '○○'로는 반복이 모자란다
  // 공백 없는 ○□ 기호('○(내용)')도 번호 기호로 떼어 본다
  const body = (matchSymbol(whole)?.rest ?? whole.replace(/^[○●□■]\s*/, '')).trim();
  if (!body) return true;
  return PLACEHOLDER_PATTERNS.some((re) => re.test(body) || re.test(whole));
}

/** 표 항목명 다듬기: 앞뒤 공백·끝의 ':' 제거, '취    급'처럼 한 글자씩 띄운 것은 붙인다 */
export function normalizeLabel(text: string): string {
  const t = text.trim().replace(/\s*[:：]\s*$/, '').trim();
  const tokens = t.split(/\s+/).filter(Boolean);
  if (tokens.length > 1 && tokens.every((x) => [...x].length === 1)) return tokens.join('');
  return tokens.join(' ');
}
