// src/lib/keyword-match.ts
// '기대 답 핵심어' 맞추기 규칙 한 곳 — 문서 찾기 평가의 답변까지 평가(rag-eval-answer.ts)와 앱 일괄 실행의 기대 핵심어(batch-spec.ts, 0088)가 함께 쓴다.
// 아무것도 import하지 않는다(화면도 읽는다).

/** 핵심어 비교용 — 공백·대소문자 무시, 숫자 사이 쉼표 무시(1,200 = 1200) */
export function keywordKey(s: string): string {
  return s.normalize('NFC').toLowerCase().replace(/(\d),(?=\d{3})/g, '$1').replace(/\s+/g, '');
}

/** 답에 없는 핵심어(주어진 순서대로) */
export function missingKeywords(answer: string, keywords: string[]): string[] {
  const text = keywordKey(answer);
  return keywords.filter((k) => !text.includes(keywordKey(k)));
}
