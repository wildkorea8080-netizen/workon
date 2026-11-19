/**
 * 대화 이름 다듬기(2026-11-19) — 잎 파일(화면·서버 공용, 아무것도 가져오지 않음).
 * 직원이 고쳐 쓰는 대화 이름은 사이드바·공개 공유 화면·감사 목록에 그대로 실린다 —
 * 줄바꿈·보이지 않는 서식 글자를 빼고 공백을 하나로, 앞뒤를 떼고 100자까지만 받는다.
 */
export const MAX_CONVERSATION_TITLE = 100;

/** 쓸 수 있는 이름이면 다듬은 글, 아니면 null(글이 아님·비었음·너무 김). */
export function cleanConversationTitle(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const text = value
    .normalize('NFC')
    .replace(/[\p{Cc}\p{Cf}]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!text || [...text].length > MAX_CONVERSATION_TITLE) return null;
  return text;
}
