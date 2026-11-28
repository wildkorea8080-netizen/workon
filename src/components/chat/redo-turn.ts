// 대화의 '답변 다시 받기·질문 고쳐 묻기'(2026-11-28) — 화면 규칙만(아무것도 import하지 않음)

export const REDO_FAILED = '답변을 지우지 못해 다시 묻지 않았습니다. 잠시 뒤 다시 시도해 주세요.';

/**
 * 같은 질문으로 다시 받을 수 있는가 — 사진은 저장하지 않아 다시 보낼 수 없고(방금 보낸 미리보기·저장된 '[첨부 이미지 N장]' 표시),
 * 질문 글이 비면 보낼 것이 없다. 이때는 '질문 고쳐 묻기'로 사진을 다시 붙인다
 */
export function canRegenerate(question: { content: string; imagePreviews?: string[] }): boolean {
  if (question.imagePreviews?.length) return false;
  if (/^\s*\[첨부 이미지 /m.test(question.content)) return false;
  return question.content.split('\n').some((line) => line.trim() && !/^\s*\[첨부 /.test(line));
}
