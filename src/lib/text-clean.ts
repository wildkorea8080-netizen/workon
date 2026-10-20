// src/lib/text-clean.ts
/**
 * 파일에서 온 글 다듬기 — 첨부 개요(file-read)와 표 계산 엔진(table-engine)이 같은 함수를 쓴다.
 * 아무것도 import하지 않는다(순수 엔진도 가져다 쓰므로).
 */

/**
 * 파일에서 온 글을 한 줄로. 줄바꿈은 공백으로, 그 밖의 제어·서식 글자(벨, 방향 바꾸기 U+202E 등)는 지운다 —
 * 줄을 깨거나 화면과 모델이 보는 글을 다르게 만들 수 있다. 한 파일·한 표가 한 줄이어야 모델이 구분한다.
 * 대괄호도 지운다 — 열 이름 '[첨부 목록 끝]'이 구분 줄을 흉내 내 목록 밖 지시처럼 보이지 않게.
 */
export function oneLine(s: string): string {
  return s
    .replace(/[\t\n\r\v\f]/g, ' ')
    .replace(/[\p{Cc}\p{Cf}[\]]/gu, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/** 글자(코드 포인트) 단위로 자른다 — 서로게이트 쌍을 반으로 가르지 않게 */
export function cut(s: string, max: number): string {
  const chars = Array.from(s);
  return chars.length > max ? `${chars.slice(0, max).join('')}…` : s;
}
