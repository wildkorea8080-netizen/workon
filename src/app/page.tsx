'use client';

import { useState, useCallback, useRef, useEffect, Suspense } from 'react';
import { useSession, signOut } from 'next-auth/react';
import { useSearchParams } from 'next/navigation';
import Link from 'next/link';
import ChatInterface from '@/components/chat/ChatInterface';
import AgentSelector from '@/components/chat/AgentSelector';
import Header from '@/components/layout/Header';
import Sidebar from '@/components/layout/Sidebar';
import type { Agent } from '@/lib/db';
import NoticesBanner from '@/components/NoticesBanner';

type ViewMode = 'welcome' | 'chat';

// ?conv=ID 딥링크 처리 — useSearchParams는 Suspense 경계 안에서만 사용 가능
function ConvLoader({ onLoad }: { onLoad: (id: string) => void }) {
  const params = useSearchParams();
  useEffect(() => {
    const id = params.get('conv');
    if (id) onLoad(id);
  // onLoad ref는 안정적이므로 deps 생략
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  return null;
}

export default function HomePage() {
  const { data: session, status } = useSession();

  const [selectedAgent, setSelectedAgent] = useState<Agent | null>(null);
  const [conversationId, setConversationId] = useState<string | null>(null);
  const [viewMode, setViewMode] = useState<ViewMode>('welcome');
  const [quickInput, setQuickInput] = useState('');
  const [sidebarRefresh, setSidebarRefresh] = useState(0);

  const lastAgentRef = useRef<Agent | null>(null);

  const handleAgentSelect = useCallback((agent: Agent | null) => {
    if (!agent) return;
    setSelectedAgent(agent);
    lastAgentRef.current = agent;
    setConversationId(null);
    setViewMode('chat');
  }, []);

  const handleConversationSelect = useCallback(async (id: string) => {
    try {
      const res = await fetch(`/api/conversations/${id}`);
      const result = await res.json();
      if (!result.ok) return;
      const conv = result.data;
      if (conv.agent) {
        setSelectedAgent(conv.agent);
        lastAgentRef.current = conv.agent;
      }
      setConversationId(id);
      setViewMode('chat');
    } catch {
      // silent
    }
  }, []);

  const handleNewConversation = useCallback(() => {
    setSelectedAgent(null);
    setConversationId(null);
    setViewMode('welcome');
    setQuickInput('');
  }, []);

  const handleConversationCreated = useCallback((id: string) => {
    setConversationId(id);
    setSidebarRefresh(n => n + 1);
  }, []);

  const handleChangeAgent = useCallback(() => {
    setSelectedAgent(null);
    setConversationId(null);
    setViewMode('welcome');
  }, []);

  const handleQuickSend = useCallback(() => {
    const agent = selectedAgent || lastAgentRef.current;
    if (!agent || !quickInput.trim()) return;
    setSelectedAgent(agent);
    setConversationId(null);
    setViewMode('chat');
    // QuickInput은 chat으로 전환 후 자동 전송 불가능하므로 clear
    setQuickInput('');
  }, [selectedAgent, quickInput]);

  // 로딩
  if (status === 'loading') {
    return (
      <div className="min-h-screen flex items-center justify-center bg-[#F5F7FA]">
        <div className="text-slate-400 text-sm">로딩 중...</div>
      </div>
    );
  }

  // 비로그인 랜딩
  if (!session) {
    return (
      <div className="min-h-screen bg-gradient-to-br from-[#1C2B4A] to-[#003087] flex items-center justify-center px-4">
        <div className="w-full max-w-sm space-y-8 text-center">
          <div>
            <div className="text-5xl mb-4">🏛️</div>
            <h1 className="text-3xl font-bold text-white mb-2">AI 업무도우미</h1>
            <p className="text-white/60 text-sm">공공기관 전용 AI 비서 플랫폼</p>
          </div>
          <div className="bg-white rounded-2xl shadow-xl p-6 space-y-3">
            <Link
              href="/login"
              className="w-full flex items-center justify-center py-3 rounded-xl bg-[#003087] hover:bg-[#002070] text-white font-semibold text-sm transition-colors"
            >
              로그인
            </Link>
          </div>
        </div>
      </div>
    );
  }

  // 부서 없음
  if (!session.user.departmentId) {
    return (
      <div className="min-h-screen flex flex-col items-center justify-center text-center space-y-4 bg-[#F5F7FA]">
        <h1 className="text-xl font-semibold text-slate-800">부서 정보가 없습니다</h1>
        <p className="text-slate-500 text-sm max-w-sm">
          로그인은 되었지만 부서가 등록되어 있지 않습니다. 관리자에게 부서 할당을 요청해주세요.
        </p>
        <button
          onClick={() => signOut({ callbackUrl: '/' })}
          className="px-4 py-2.5 bg-slate-800 text-white text-sm font-medium rounded-xl"
        >
          로그아웃
        </button>
      </div>
    );
  }

  const userName = session.user.name || session.user.email?.split('@')[0] || '사용자';

  return (
    <div className="flex flex-col h-screen bg-[#F5F7FA] overflow-hidden" style={{ fontFamily: 'Pretendard, -apple-system, sans-serif' }}>
      <Suspense fallback={null}>
        <ConvLoader onLoad={handleConversationSelect} />
      </Suspense>

      {/* 고정 헤더 */}
      <Header />
      {/* 공지 배너 */}
      <NoticesBanner />

      {/* 헤더 아래 영역 */}
      <div className="flex flex-1 overflow-hidden pt-14">
        {/* 사이드바 */}
        <Sidebar
          selectedConversationId={conversationId}
          onConversationSelect={handleConversationSelect}
          onNewConversation={handleNewConversation}
          refreshTrigger={sidebarRefresh}
        />

        {/* 메인 영역 */}
        <main className="flex-1 flex flex-col overflow-hidden">
          {viewMode === 'chat' && selectedAgent ? (
            <ChatInterface
              selectedAgent={selectedAgent}
              conversationId={conversationId}
              onConversationCreated={handleConversationCreated}
              onChangeAgent={handleChangeAgent}
            />
          ) : (
            <WelcomeView
              userName={userName}
              quickInput={quickInput}
              onQuickInputChange={setQuickInput}
              onQuickSend={handleQuickSend}
              onAgentSelect={handleAgentSelect}
              hasLastAgent={!!lastAgentRef.current}
            />
          )}
        </main>
      </div>
    </div>
  );
}

interface WelcomeViewProps {
  userName: string;
  quickInput: string;
  onQuickInputChange: (v: string) => void;
  onQuickSend: () => void;
  onAgentSelect: (agent: Agent) => void;
  hasLastAgent: boolean;
}

function WelcomeView({
  userName,
  quickInput,
  onQuickInputChange,
  onQuickSend,
  onAgentSelect,
  hasLastAgent,
}: WelcomeViewProps) {
  return (
    <div className="flex flex-col h-full overflow-y-auto">
      {/* 환영 메시지 + 입력창 */}
      <div className="flex flex-col items-center justify-center pt-12 pb-6 px-6">
        <h1 className="text-2xl font-bold text-slate-900 mb-1">
          안녕하세요, {userName}님! 👋
        </h1>
        <p className="text-slate-500 text-sm mb-8">오늘 어떤 업무를 도와드릴까요?</p>

        {/* 빠른 입력창 */}
        <div className="w-full max-w-2xl">
          <div className="flex items-end gap-3 bg-white border border-slate-200 rounded-2xl px-5 py-4 shadow-sm focus-within:border-[#003087] focus-within:ring-2 focus-within:ring-[#003087]/10 transition-all">
            <textarea
              value={quickInput}
              onChange={e => onQuickInputChange(e.target.value)}
              onKeyDown={e => {
                if (e.key === 'Enter' && !e.shiftKey) {
                  e.preventDefault();
                  onQuickSend();
                }
              }}
              placeholder="비서에게 바로 질문하거나 아래에서 비서를 선택하세요"
              rows={1}
              className="flex-1 bg-transparent text-sm text-slate-900 placeholder-slate-400 resize-none focus:outline-none leading-relaxed"
              style={{ minHeight: '24px', maxHeight: '120px' }}
            />
            <button
              onClick={onQuickSend}
              disabled={!quickInput.trim() || !hasLastAgent}
              className="flex-shrink-0 w-9 h-9 rounded-xl bg-[#003087] hover:bg-[#002070] disabled:bg-slate-200 disabled:cursor-not-allowed text-white flex items-center justify-center transition-colors"
            >
              <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M5 12h14M12 5l7 7-7 7" />
              </svg>
            </button>
          </div>
          {!hasLastAgent && (
            <p className="text-xs text-slate-400 mt-2 text-center">아래에서 비서를 먼저 선택하면 바로 대화를 시작할 수 있어요.</p>
          )}
        </div>
      </div>

      {/* 비서 선택 */}
      <div className="flex-1 px-0 pb-6">
        <div className="mx-6 mb-3">
          <h2 className="text-sm font-semibold text-slate-500 uppercase tracking-wider">AI 비서 선택</h2>
        </div>
        <AgentSelector
          selectedAgent={null}
          onAgentSelect={agent => { if (agent) onAgentSelect(agent); }}
        />
      </div>
    </div>
  );
}
