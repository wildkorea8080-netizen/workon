/**
 * 찾기 글을 PostgREST 필터에 넣을 때(2026-11-18) — 잎 파일.
 *
 * `.or(\`email.ilike.%${search}%,full_name.ilike.%${search}%\`)`처럼 사용자가 친 글을 필터 글에 그대로 넣으면 쉼표·괄호가
 * 필터 문법으로 읽힌다 — 찾기 칸에 `a,b`만 쳐도 조회가 깨져(500) 슈퍼관리자 계정 관리·기관 사용자 찾기가 멈췄고, 조건을 덧붙일 수도 있다.
 * PostgREST는 값을 큰따옴표로 감싸면 쉼표·점·괄호를 글자로 읽는다 — 그래서 값을 감싸고, 감싸기를 깨는 `"`·`\`와 제어·서식 글자만 뺀다
 * (이메일의 점·밑줄은 그대로 찾힌다). 60자로 자른다.
 */

export const SEARCH_MAX_CHARS = 60;

/** 필터에 넣어도 되는 찾기 글 — 남는 글이 없으면 null */
export function searchTerm(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const s = raw
    .normalize('NFC')
    .replace(/["\\\p{Cc}\p{Cf}]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, SEARCH_MAX_CHARS)
    .trim();
  return s || null;
}

/** 여러 칸 중 하나라도 글을 품으면 — `.or()`에 넣을 글(값은 큰따옴표로 감쌈) */
export function orIlike(columns: string[], term: string): string {
  return columns.map((c) => `${c}.ilike."%${term}%"`).join(',');
}
