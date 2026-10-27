'use client';

import ChatHome from '@/components/chat/ChatHome';

/** 기존 AI 대화 — 비서·대화·공유·첨부 기능을 그대로 둔다. `/chat?conv=ID`로 지난 대화를 연다 */
export default function ChatPage() {
  return <ChatHome />;
}
