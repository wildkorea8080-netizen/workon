// 대화 목록 찾기 칸의 화면 규칙(2026-11-28) — 아무것도 import하지 않음(서버의 conversation-search.ts와 같은 하한)

/** 이 글자 수부터 서버가 내 모든 대화의 제목·내용을 찾는다(그보다 짧으면 읽어 둔 목록의 제목만) */
export const SEARCH_MIN_CHARS = 2;

export const SEARCH_FAILED = '지금 대화를 찾지 못했습니다. 잠시 뒤 다시 찾아 주세요.';

export function searchActive(term: string): boolean {
  return Array.from(term.replace(/[\p{Cc}\p{Cf}]/gu, ' ').replace(/\s+/g, ' ').trim()).length >= SEARCH_MIN_CHARS;
}
