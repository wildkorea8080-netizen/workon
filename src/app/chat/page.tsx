'use client';

import ChatHome from '@/components/chat/ChatHome';

/** AI 대화 — 업무 화면 틀 안에서 비서·대화·공유·첨부 기능을 그대로 쓴다. `/chat?conv=ID`로 지난 대화를 연다 */
export default function ChatPage() {
  return <ChatHome workspace />;
}
