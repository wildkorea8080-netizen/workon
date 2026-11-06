/**
 * 업무 틀의 사이드바(최근 대화)와 대화 화면 사이의 알림 — 둘은 서로를 import하지 않는다(2026-11-06).
 * 대화 고르기는 주소(`/chat?conv=ID`)로, '새 대화'와 '목록 다시 읽기'는 창 이벤트로 잇는다.
 * 아무것도 import하지 않는다(화면 잎 파일)
 */
export const CHAT_NEW_EVENT = 'workon:chat-new';
export const CHAT_LIST_CHANGED_EVENT = 'workon:conversations-changed';

/** 사이드바 '새 대화' — 이미 대화 화면이면 주소가 그대로라 화면이 이 알림으로 첫 화면에 돌아간다 */
export function announceNewChat(): void {
  if (typeof window !== 'undefined') window.dispatchEvent(new Event(CHAT_NEW_EVENT));
}

/** 대화가 생겼거나 제목이 붙었다 — 사이드바가 목록을 다시 읽는다 */
export function announceConversationsChanged(): void {
  if (typeof window !== 'undefined') window.dispatchEvent(new Event(CHAT_LIST_CHANGED_EVENT));
}

/** 대화 주소 — 사이드바가 고른 대화를 연다 */
export function conversationHref(id: string): string {
  return `/chat?conv=${encodeURIComponent(id)}`;
}
