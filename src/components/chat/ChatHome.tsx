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
import { announceConversationsChanged, CHAT_NEW_EVENT, conversationHref } from '@/lib/chat-events';
import { pickDefaultAgent } from '@/lib/chat-default-agent';

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
  // 비서를 고르지 않고 첫 화면에서 바로 물을 때 답할 비서(마지막으로 쓴 비서 → 첫 공식 비서), 그리고 그 질문
  const [defaultAgent, setDefaultAgent] = useState<Agent | null>(null);
  const [initialMessage, setInitialMessage] = useState<string | null>(null);

  const lastAgentRef = useRef<Agent | null>(null);
  // 지금 열린 대화 — 주소(`?conv=`)가 같은 대화를 다시 가리켜도(만든 뒤 주소를 바꿀 때·사이드바에서 같은 대화를 누를 때) 다시 불러오지 않는다
  const conversationIdRef = useRef<string | null>(null);

  const handleAgentSelect = useCallback((agent: Agent | null) => {
    if (!agent) return;
    if (agent.app_definition) { router.push(`/apps/run?agent=${encodeURIComponent(agent.id)}`); return; }
    setSelectedAgent(agent);
    lastAgentRef.current = agent;
    conversationIdRef.current = null;
    setInitialMessage(null);
    setConversationId(null);
    setViewMode('chat');
  }, [router]);

  const handleConversationSelect = useCallback(async (id: string) => {
    if (conversationIdRef.current === id) return;
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

      conversationIdRef.current = id;
      setInitialMessage(null);
      setConversationId(id);
      setViewMode('chat');
    } catch {
      // silent
    }
  }, []);

  const handleNewConversation = useCallback(() => {
    conversationIdRef.current = null;
    setSelectedAgent(null);
    setConversationId(null);
    setViewMode('welcome');
    setQuickInput('');
    setInitialMessage(null);
  }, []);

  const handleConversationCreated = useCallback((id: string) => {
    conversationIdRef.current = id;
    setInitialMessage(null);
    setConversationId(id);
    setSidebarRefresh(n => n + 1);
    if (workspace) {
      // 사이드바(업무 틀)가 목록을 다시 읽고 이 대화를 고른 것으로 보이게 — 주소만 바꾸고 화면은 다시 그리지 않는다
      announceConversationsChanged();
      window.history.replaceState(null, '', conversationHref(id));
    }
  }, [workspace]);

  const handleChangeAgent = useCallback(() => {
    conversationIdRef.current = null;
    setSelectedAgent(null);
    setConversationId(null);
    setViewMode('welcome');
  }, []);

  // 첫 화면에서 적은 질문을 그 비서의 대화로 보낸다(대화 화면이 열리며 한 번 보냄) — 예전에는 화면만 바뀌고 적은 글이 버려졌다
  const handleQuickSend = useCallback(() => {
    const agent = selectedAgent || lastAgentRef.current || defaultAgent;
    const text = quickInput.trim();
    if (!agent || !text) return;
    setSelectedAgent(agent);
    lastAgentRef.current = agent;
    conversationIdRef.current = null;
    setConversationId(null);
    setInitialMessage(text);
    setViewMode('chat');
    setQuickInput('');
  }, [selectedAgent, quickInput, defaultAgent]);

  // 답할 비서 고르기 — 화면이 받은 목록(서버가 권한으로 거른 것)과 마지막 대화의 비서로. 실패하면 예전처럼 비서를 먼저 고르게 한다
  const signedIn = Boolean(session?.user?.departmentId);
  useEffect(() => {
    if (!signedIn) return;
    let alive = true;
    const read = (url: string) => fetch(url).then((r) => r.json()).then((b) => (b?.ok && Array.isArray(b.data) ? b.data : [])).catch(() => []);
    Promise.all([read('/api/agents'), read('/api/agents?personal=true'), read('/api/conversations?limit=1')]).then(([shared, personal, recent]) => {
      if (!alive) return;
      const last = recent[0]?.agent;
      const lastId = (Array.isArray(last) ? last[0]?.id : last?.id) ?? null;
      setDefaultAgent(pickDefaultAgent([...shared, ...personal] as Agent[], lastId));
    });
    return () => { alive = false; };
  }, [signedIn]);

  // 업무 틀 사이드바의 '+ 새 대화' — 이미 /chat이면 주소가 그대로라 알림으로 첫 화면에 돌아간다
  useEffect(() => {
    if (!workspace) return;
    const reset = () => handleNewConversation();
    window.addEventListener(CHAT_NEW_EVENT, reset);
    return () => window.removeEventListener(CHAT_NEW_EVENT, reset);
  }, [workspace, handleNewConversation]);

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
      {/* 대화 목록 — 업무 틀에서는 틀의 사이드바 '최근 대화'가 맡는다(2026-11-06) */}
      {!workspace && <Sidebar
        selectedConversationId={conversationId}
        onConversationSelect={handleConversationSelect}
        onNewConversation={handleNewConversation}
        refreshTrigger={sidebarRefresh}
      />}

      {/* 메인 영역 */}
      <section aria-label="AI 대화" className="flex min-w-0 flex-1 flex-col overflow-hidden">
        {viewMode === 'chat' && selectedAgent ? (
          <ChatInterface
            selectedAgent={selectedAgent}
            conversationId={conversationId}
            onConversationCreated={handleConversationCreated}
            onChangeAgent={handleChangeAgent}
            initialMessage={initialMessage}
          />
        ) : (
          <WelcomeView
            userName={userName}
            quickInput={quickInput}
            onQuickInputChange={setQuickInput}
            onQuickSend={handleQuickSend}
            onAgentSelect={handleAgentSelect}
            answeringAgentName={(lastAgentRef.current ?? defaultAgent)?.name ?? null}
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
          {/* 작은 화면에서는 틀의 사이드바가 숨으므로 지난 대화를 여기서 연다 */}
          <details className="md:hidden border-b border-[#E9EBF2] bg-white">
            <summary className="cursor-pointer px-4 py-3 text-sm font-semibold text-[#087581]">지난 대화</summary>
            <div className="flex max-h-[50vh] flex-col overflow-hidden px-3 pb-3">
              <Sidebar
                embedded
                selectedConversationId={conversationId}
                onConversationSelect={(id) => router.push(conversationHref(id))}
                onNewConversation={handleNewConversation}
                refreshTrigger={sidebarRefresh}
              />
            </div>
          </details>
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
  /** 바로 물으면 답할 비서 이름 — 없으면 비서를 먼저 골라야 한다 */
  answeringAgentName: string | null;
}

function WelcomeView({
  userName,
  quickInput,
  onQuickInputChange,
  onQuickSend,
  onAgentSelect,
  answeringAgentName,
}: WelcomeViewProps) {
  const hasLastAgent = Boolean(answeringAgentName);
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
        {hasLastAgent ? (
          // 누가 답하는지 숨기지 않는다 — 비서마다 문서·기능이 다르다
          <p className="mt-2 text-xs text-slate-500">
            답할 비서: <span className="font-semibold text-[#087581]">{answeringAgentName}</span> · 다른 비서에게 물으려면 아래에서 고르세요
          </p>
        ) : (
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
