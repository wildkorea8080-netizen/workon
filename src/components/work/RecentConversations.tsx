'use client';

import { useEffect, useState } from 'react';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import Sidebar from '@/components/layout/Sidebar';
import { announceNewChat, CHAT_LIST_CHANGED_EVENT, conversationHref } from '@/lib/chat-events';

/**
 * 업무 틀 사이드바의 '최근 대화'(2026-11-06) — 업무 메뉴와 대화 목록을 사이드바 하나에 둔다(알리웍스·웍스AI와 같은 꼴).
 * 대화를 고르면 `/chat?conv=ID`로 가고, 대화 화면은 주소를 보고 그 대화를 연다. 고른 대화 표시도 주소에서 읽는다.
 * useSearchParams를 쓰므로 Suspense 안에서 그린다(WorkShell)
 */
export default function RecentConversations() {
  const router = useRouter();
  const pathname = usePathname() ?? '/';
  const params = useSearchParams();
  const [refresh, setRefresh] = useState(0);
  const selected = pathname.startsWith('/chat') ? params.get('conv') : null;

  useEffect(() => {
    const bump = () => setRefresh((n) => n + 1);
    window.addEventListener(CHAT_LIST_CHANGED_EVENT, bump);
    return () => window.removeEventListener(CHAT_LIST_CHANGED_EVENT, bump);
  }, []);

  function startNew() {
    // 이미 대화 화면이면 주소가 그대로일 수 있어 알림으로 첫 화면에 돌린다
    if (pathname.startsWith('/chat')) announceNewChat();
    router.push('/chat');
  }

  return (
    <section aria-label="최근 대화" className="flex min-h-0 flex-1 flex-col border-t border-[#E9EBF2] pt-3">
      <div className="mb-2 flex items-center justify-between px-3">
        <h2 className="text-[11px] font-bold tracking-[.12em] text-slate-400">최근 대화</h2>
        <button type="button" onClick={startNew} className="rounded-lg px-2 py-1 text-xs font-semibold text-ws-accent-text hover:bg-ws-accent-soft">+ 새 대화</button>
      </div>
      <Sidebar
        embedded
        selectedConversationId={selected}
        onConversationSelect={(id) => router.push(conversationHref(id))}
        onNewConversation={startNew}
        refreshTrigger={refresh}
      />
    </section>
  );
}
