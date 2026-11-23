// 금지어 맞추기 도우미 — 대화 입력 필터(filter.ts)와 같은 규칙(forbidden-match.ts)으로 글에서 금지어를 찾는다.
//
// 2026-11-22: 이 파일에 있던 금지어 DB 함수 다섯(목록·더하기·켜고 끄기·지우기·통계)은 지웠다. 어디서도 쓰지 않았고,
// 공개 키(@/lib/supabase)로 표를 읽고 써서 0090(공개 키 권한 거둠) 뒤로는 부르면 조용히 실패했다(목록은 빈 배열).
// 금지어 표는 /api/forbidden-words 라우트가 서비스 키와 관리 범위(forbidden-words-scope.ts)로 다룬다.

import type { ForbiddenWord } from '@/lib/db';
import { containsForbiddenWord } from '@/lib/forbidden-match';

/**
 * 텍스트에 금지어가 포함되어 있는지 확인합니다.
 */
export function containsForbiddenWords(text: string, forbiddenWords: ForbiddenWord[]): {
  hasForbiddenWords: boolean;
  foundWords: string[];
} {
  const activeWords = forbiddenWords.filter(fw => fw.is_active);
  const foundWords: string[] = [];

  for (const fw of activeWords) {
    // 대화 입력 필터와 같은 규칙(forbidden-match.ts) — 예전 `\b`로는 한글 금지어를 잡지 못했다
    if (containsForbiddenWord(text, fw.word)) {
      foundWords.push(fw.word);
    }
  }

  return {
    hasForbiddenWords: foundWords.length > 0,
    foundWords,
  };
}
