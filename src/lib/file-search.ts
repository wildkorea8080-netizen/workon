// src/lib/file-search.ts
// 내 파일 이름 찾기 규칙(2026-11-08) — 결과물 화면의 세 목록(업무 결과물·대화에서 만든 파일·대화에 올린 파일)이 같은 규칙으로 찾는다.
// 화면도 쓰므로 아무것도 가져오지 않는다(잎 파일).

/** 찾기 글 상한 */
export const MY_FILES_QUERY_MAX = 60;

/** 찾기 글 다듬기 — 제어·서식 글자를 빼고 공백을 하나로 접어 60자까지. 비면 null(찾지 않음) */
export function normalizeFileQuery(raw: string | null | undefined): string | null {
  if (typeof raw !== 'string') return null;
  const text = Array.from(raw.replace(/[\p{Cc}\p{Cf}]/gu, ' ').replace(/\s+/g, ' ').trim()).slice(0, MY_FILES_QUERY_MAX).join('').trim();
  return text || null;
}

/** DB 찾기용 — 이름에 그 글이 들어 있는 파일. LIKE의 `%`·`_`·`\\`는 글자 그대로 찾도록 막는다(대소문자 무시는 ilike가) */
export function fileNamePattern(query: string): string {
  return `%${query.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
}

/** 화면에서 거르는 목록용 — 글 가운데 하나라도 찾기 글을 품으면(대소문자 무시, NFC). 찾기 글이 비면 모두 맞음 */
export function matchesFileQuery(query: string | null, ...texts: (string | null | undefined)[]): boolean {
  const q = normalizeFileQuery(query);
  if (!q) return true;
  const needle = q.normalize('NFC').toLowerCase();
  return texts.some((t) => typeof t === 'string' && t.normalize('NFC').toLowerCase().includes(needle));
}
