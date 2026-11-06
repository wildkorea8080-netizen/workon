'use client';

import { useState, useCallback, useRef, useEffect, Suspense } from 'react';
import { useSession, signOut } from 'next-auth/react';
import { useSearchParams, useRouter } from 'next/navigation';
import Link from 'next/link';
import ChatInterface from '@/components/chat/ChatInterface';
import AgentSelector from '@/components/chat/AgentSelector';
import Header from '@/components/layout/Header';
import WelcomeTour from '@/components/chat/WelcomeTour';
import Sidebar from '@/components/layout/Sidebar';
import type { Agent } from '@/lib/db';
import NoticesBanner from '@/components/NoticesBanner';
import { chatLaunchTarget, loadChatLaunchAgent } from '@/lib/apps/chat-launch';
import WorkShell from '@/components/work/WorkShell';

type ViewMode = 'welcome' | 'chat';

// ?conv=ID 딥링크 처리 — useSearchParams는 Suspense 경계 안에서만 사용 가능
function ConvLoader({ onLoad, onAgent, onError }: { onLoad: (id: string) => void; onAgent: (agent: Agent) => void; onError: (message: string | null) => void }) {
  const params = useSearchParams();
  const target = chatLaunchTarget(params);
  const kind = target?.kind;
  const id = target?.id;
  useEffect(() => {
    if (!id) return;
    let active = true;
    onError(null);
    if (kind === 'conversation') onLoad(id);
    else void loadChatLaunchAgent(id).then((agent) => {
      if (!active) return;
      if (agent) onAgent(agent);
      else onError('이 비서를 열 수 없습니다. 사용할 수 있는 비서를 다시 골라 주세요.');
    }).catch(() => { if (active) onError('비서를 불러오지 못했습니다. 잠시 후 다시 시도해 주세요.'); });
    return () => { active = false; };
  }, [kind, id, onLoad, onAgent, onError]);
  return null;
}

/**
 * `workspace`면 업무 화면 틀(WorkShell — 헤더·공지·왼쪽 업무 메뉴·밝은 바탕) 안에 대화를 그린다(`/chat`, 2026-11-06).
 * 업무 홈을 끈 기관의 `/`는 예전처럼 틀 없이 그린다
 */
export default function ChatHome({ workspace = false }: { workspace?: boolean } = {}) {
  const router = useRouter();
  const { data: session, status } = useSession();

  const [selectedAgent, setSelectedAgent] = useState<Agent | null>(null);
  const [conversationId, setConversationId] = useState<string | null>(null);
  const [viewMode, setViewMode] = useState<ViewMode>('welcome');
  const [quickInput, setQuickInput] = useState('');
  const [sidebarRefresh, setSidebarRefresh] = useState(0);
  const [launchError, setLaunchError] = useState<string | null>(null);

  const lastAgentRef = useRef<Agent | null>(null);

  const handleAgentSelect = useCallback((agent: Agent | null) => {
    if (!agent) return;
    if (agent.app_definition) { router.push(`/apps/run?agent=${encodeURIComponent(agent.id)}`); return; }
    setSelectedAgent(agent);
    lastAgentRef.current = agent;
    setConversationId(null);
    setViewMode('chat');
  }, [router]);

  const handleConversationSelect = useCallback(async (id: string) => {
    try {
      const res = await fetch(`/api/conversations/${id}`);
      const result = await res.json();
      if (!result.ok) return;
      const conv = result.data;

      // Supabase join이 객체 또는 배열로 올 수 있으므로 정규화
      const agentData = Array.isArray(conv.agent) ? conv.agent[0] : conv.agent;
      if (agentData?.id) {
        setSelectedAgent(agentData);
        lastAgentRef.current = agentData;
      } else if (lastAgentRef.current) {
        setSelectedAgent(lastAgentRef.current);
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
      <div className="min-h-screen flex items-center justify-center bg-[#F7F8FC]">
        <div className="text-slate-400 text-sm">로딩 중...</div>
      </div>
    );
  }

  // 비로그인 랜딩
  if (!session) {
    return (
      <div className="min-h-screen bg-gradient-to-br from-[#1C2B4A] to-[#087f8c] flex items-center justify-center px-4">
        <div className="w-full max-w-sm space-y-8 text-center">
          <div>
            <div className="text-5xl mb-4">🏛️</div>
            <h1 className="text-3xl font-bold text-white mb-2">AI 업무도우미</h1>
            <p className="text-white/60 text-sm">공공기관 전용 AI 비서 플랫폼</p>
          </div>
          <div className="bg-white rounded-2xl shadow-xl p-6 space-y-3">
            <Link
              href="/login"
              className="w-full flex items-center justify-center py-3 rounded-xl bg-[#087f8c] hover:bg-[#066775] text-white font-semibold text-sm transition-colors"
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
      <div className="min-h-screen flex flex-col items-center justify-center text-center space-y-4 bg-[#F7F8FC]">
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

  const launchNote = launchError && <p role="alert" className="bg-amber-50 px-4 py-3 text-sm text-amber-800">{launchError} <Link href="/apps" className="underline">업무 앱 보기</Link></p>;
  const body = (
    <div className="flex flex-1 overflow-hidden">
      {/* 대화 목록 */}
      <Sidebar
        selectedConversationId={conversationId}
        onConversationSelect={handleConversationSelect}
        onNewConversation={handleNewConversation}
        refreshTrigger={sidebarRefresh}
      />

      {/* 메인 영역 */}
      <section aria-label="AI 대화" className="flex min-w-0 flex-1 flex-col overflow-hidden">
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
      </section>
    </div>
  );
  const loader = (
    <Suspense fallback={null}>
      <ConvLoader onLoad={handleConversationSelect} onAgent={handleAgentSelect} onError={setLaunchError} />
    </Suspense>
  );

  if (workspace) {
    return (
      <WorkShell>
        {loader}
        <WelcomeTour />
        <div className="flex h-full flex-col overflow-hidden">
          {launchNote}
          {body}
        </div>
      </WorkShell>
    );
  }

  return (
    <div className="flex flex-col h-screen bg-[#F7F8FC] overflow-hidden" style={{ fontFamily: 'Pretendard, -apple-system, sans-serif' }}>
      {loader}

      {/* 헤더를 fixed로 두면 흐름에서 빠져 바로 아래 공지 배너가 그 뒤에 깔린다.
          슈퍼관리자가 공지를 띄워도 직원 화면에서는 보이지 않았다.
          바깥이 이미 h-screen flex-col이라 고정할 이유가 없다 — 흐름에 두면
          헤더·배너·본문이 순서대로 쌓이고 배너 높이도 저절로 반영된다. */}
      <WelcomeTour />
      <Header />
      <NoticesBanner />
      {launchNote}
      {body}
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
    <div className="flex h-full flex-col overflow-y-auto">
      <div className="mx-auto w-full max-w-5xl px-5 pb-4 pt-9 md:px-9">
        <p className="mb-3 text-[11px] font-bold tracking-[.18em] text-[#467b82]">AI ASSISTANT</p>
        <div className="mb-6 flex flex-wrap items-end justify-between gap-4">
          <div>
            <h1 className="text-[26px] font-bold leading-tight tracking-tight text-[#22283D]">안녕하세요, {userName}님</h1>
            {/* 무엇이 되는지 첫 화면에서 알린다. 이미지 첨부는 새로 생긴 기능이라
                알리지 않으면 아무도 쓰지 않는다.
                **되는 것만 적는다** — 그림 생성처럼 없는 기능을 적으면 담당자가
                시도했다가 안 되는 것을 발견하고 신뢰를 잃는다. */}
            <p className="mt-2 text-[14px] leading-6 text-slate-500">기관 문서를 근거로 답하고, 사진·화면 캡처도 읽습니다.</p>
          </div>
          <Link href="/apps" className="rounded-xl border border-[#E7E9F1] bg-white px-4 py-2.5 text-sm font-semibold text-[#087581] hover:border-[#9bc9ce]">
            업무 앱 둘러보기
          </Link>
        </div>

        {/* 빠른 입력창 */}
        <div className="workspace-card flex items-end gap-3 rounded-2xl border border-[#E7E9F1] bg-white px-5 py-4 transition-all focus-within:border-[#16818c] focus-within:ring-2 focus-within:ring-[#16818c]/15">
          <textarea
            value={quickInput}
            onChange={e => onQuickInputChange(e.target.value)}
            onKeyDown={e => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                onQuickSend();
              }
            }}
            aria-label="질문 입력"
            placeholder="무엇이든 물어보세요. 아래에서 비서를 고르면 더 정확합니다"
            rows={1}
            className="flex-1 resize-none border-0 bg-transparent text-sm leading-relaxed text-slate-900 placeholder-slate-400 focus:outline-none"
            style={{ minHeight: '24px', maxHeight: '120px' }}
          />
          <button
            onClick={onQuickSend}
            disabled={!quickInput.trim() || !hasLastAgent}
            aria-label="보내기"
            className="flex h-9 w-9 flex-shrink-0 items-center justify-center rounded-xl bg-[#087f8c] text-white transition-colors hover:bg-[#066775] disabled:cursor-not-allowed disabled:bg-slate-200"
          >
            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M5 12h14M12 5l7 7-7 7" />
            </svg>
          </button>
        </div>
        {!hasLastAgent && (
          <p className="mt-2 text-xs text-slate-400">아래에서 비서를 먼저 고르면 바로 대화를 시작할 수 있어요.</p>
        )}
      </div>

      {/* 비서 선택 */}
      <div className="mx-auto w-full max-w-5xl flex-1 pb-8">
        <div className="mx-5 mb-3 mt-4 md:mx-9">
          <h2 className="text-lg font-bold tracking-tight text-[#22283D]">대화할 AI 비서</h2>
          <p className="mt-1 text-sm text-slate-500">비서를 고르면 그 비서의 문서와 기능으로 답합니다.</p>
        </div>
        <AgentSelector
          selectedAgent={null}
          onAgentSelect={agent => { if (agent) onAgentSelect(agent); }}
        />
      </div>
    </div>
  );
}
