'use client';

import { useState, useEffect, useCallback, useRef } from 'react';
import { useSession } from 'next-auth/react';
import type { Agent } from '@/lib/db';
import AgentCard from './AgentCard';
import CreateAgentModal from './CreateAgentModal';
import AgentEditorModal from '@/components/agents/AgentEditorModal';

const TABS = [
  { key: 'all',      label: '전체' },
  { key: 'fav',      label: '즐겨찾기', icon: '★' },
  { key: '공공기관', label: '공공기관' },
  { key: '업무',     label: '업무' },
  { key: '문서',     label: '문서' },
  { key: '번역',     label: '번역' },
  { key: 'dept',     label: '부서 비서' },
  { key: 'personal', label: '내 비서' },
] as const;

type TabKey = (typeof TABS)[number]['key'];

interface AgentSelectorProps {
  selectedAgent: Agent | null;
  onAgentSelect: (agent: Agent | null) => void;
}

const FAVORITE_FAILED = '즐겨찾기를 바꾸지 못했습니다. 잠시 뒤 다시 눌러 주세요.';

/**
 * 비서 목록을 못 읽었을 때의 글(2026-11-21). 예전엔 서버 안내가 비면 오류가 빈 글이 되어 **앞 탭의 비서가 새 탭의 목록처럼** 남았고,
 * 몸이 JSON이 아니면 영어 구문 오류 글이 보였다. 늦게 온 앞 탭 응답이 새 탭 목록을 덮기도 했다(탭을 빨리 바꾸면).
 */
export const AGENT_LIST_UNREAD = '비서 목록을 지금 불러오지 못했습니다. 잠시 뒤 다시 눌러 주세요.';

export default function AgentSelector({ selectedAgent, onAgentSelect }: AgentSelectorProps) {
  const [activeTab, setActiveTab] = useState<TabKey>('all');
  const [agents, setAgents] = useState<Agent[]>([]);
  const [favoriteIds, setFavoriteIds] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  // 즐겨찾기를 바꾸지 못한 것(2026-11-20) — 예전엔 ★을 눌러도 아무 일이 없고 까닭도 없었다
  const [favoriteError, setFavoriteError] = useState<string | null>(null);
  const [showCreateModal, setShowCreateModal] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const { data: session } = useSession();
  // 마지막으로 건 목록 읽기 — 늦게 온 앞 탭의 응답은 버린다
  const requestSeq = useRef(0);

  const fetchAgents = useCallback(async (tab: TabKey) => {
    const seq = ++requestSeq.current;
    setLoading(true);
    setError(null);
    try {
      let url = '/api/agents';
      if (tab === 'fav') url = '/api/agents?favorites=true';
      else if (tab === 'dept') url = '/api/agents?department=true';
      else if (tab === 'personal') url = '/api/agents?personal=true';
      else if (tab !== 'all') url = `/api/agents?category=${encodeURIComponent(tab)}`;

      const res = await fetch(url);
      const result = await res.json().catch(() => null);
      if (seq !== requestSeq.current) return;
      if (!res.ok || !result?.ok || !Array.isArray(result.data)) {
        setAgents([]);
        setError((typeof result?.error?.message === 'string' && result.error.message) || AGENT_LIST_UNREAD);
        return;
      }
      setAgents(result.data);
      if (result.meta?.favoriteIds) setFavoriteIds(result.meta.favoriteIds);
    } catch {
      if (seq !== requestSeq.current) return;
      setAgents([]);
      setError(AGENT_LIST_UNREAD);
    } finally {
      if (seq === requestSeq.current) setLoading(false);
    }
  }, []);

  useEffect(() => { fetchAgents(activeTab); }, [activeTab, fetchAgents]);

  const handleTabChange = (tab: TabKey) => {
    setActiveTab(tab);
  };

  const handleFavoriteToggle = async (agentId: string) => {
    try {
      const res = await fetch('/api/agents/favorite', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ agentId }),
      });
      const result = await res.json().catch(() => null);
      if (!result?.ok) { setFavoriteError(result?.error?.message ?? FAVORITE_FAILED); return; }
      setFavoriteError(null);
      setFavoriteIds(result.data.favoriteIds);
      // 즐겨찾기 탭에서 토글하면 목록에서 제거
      if (activeTab === 'fav' && !result.data.isFavorite) {
        setAgents(prev => prev.filter(a => a.id !== agentId));
      }
    } catch {
      setFavoriteError(FAVORITE_FAILED);
    }
  };

  return (
    <>
    {showCreateModal && (
      <CreateAgentModal
        onClose={() => setShowCreateModal(false)}
        onCreated={(tier) => {
          setShowCreateModal(false);
          const next: TabKey = tier === 'department' ? 'dept' : 'personal';
          setActiveTab(next);
          // 이미 그 탭이면 activeTab이 안 바뀌어 effect가 돌지 않는다
          fetchAgents(next);
        }}
      />
    )}
    <div className="workspace-card mx-5 flex flex-col rounded-2xl border border-[#E7E9F1] bg-white md:mx-9">
      {/* 탭 바 — 업무 앱 목록의 알약 단추와 같은 꼴 */}
      <div role="group" aria-label="비서 분류" className="flex items-center gap-2 overflow-x-auto px-4 pt-4 scrollbar-none">
        {TABS.map(tab => (
          <button
            key={tab.key}
            onClick={() => handleTabChange(tab.key)}
            aria-pressed={activeTab === tab.key}
            className={`flex items-center gap-1 whitespace-nowrap rounded-full border px-4 py-2 text-xs font-medium transition-colors ${
              activeTab === tab.key
                ? 'border-ws-accent bg-ws-accent text-white'
                : 'border-[#E5E7EF] bg-white text-slate-500 hover:border-ws-accent-border'
            }`}
          >
            {'icon' in tab && <span className="text-amber-400">{tab.icon}</span>}
            {tab.label}
          </button>
        ))}
      </div>

      {/* 컨텐츠 */}
      <div className="p-4">
        {favoriteError && <p role="alert" className="mb-3 text-center text-xs text-red-500">{favoriteError}</p>}
        {loading ? (
          <div className="text-center py-6 text-sm text-slate-400">
            <div className="inline-block w-5 h-5 border-2 border-ws-accent-text border-t-transparent rounded-full animate-spin mb-2" />
            <p>불러오는 중...</p>
          </div>
        ) : error ? (
          <div className="text-center py-4 text-sm text-red-500">{error}</div>
        ) : (
          <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 gap-3">
            {agents.map(agent => (
              <AgentCard
                key={agent.id}
                agent={agent}
                isFavorite={favoriteIds.includes(agent.id)}
                onFavoriteToggle={handleFavoriteToggle}
                onSelect={a => onAgentSelect(selectedAgent?.id === a.id ? null : a)}
                onApprovalRequested={() => fetchAgents(activeTab)}
                myDepartmentId={session?.user?.departmentId ?? null}
                onEdit={(a) => setEditingId(a.id)}
                onPromoted={() => {
                  // 올린 비서는 '부서 비서' 탭에 있다. 만들기 뒤 이동과 같은 방식으로
                  // 옮기고, 이미 그 탭이면 effect가 안 도므로 직접 다시 읽는다.
                  setActiveTab('dept');
                  fetchAgents('dept');
                }}
              />
            ))}

            {/* 내 비서 탭: 새 비서 만들기 카드 */}
            {activeTab === 'personal' && (
              <button
                onClick={() => setShowCreateModal(true)}
                className="flex flex-col items-center justify-center gap-2 p-4 bg-[#FAFBFD] border-2 border-dashed border-[#E0E4ED] rounded-2xl text-slate-400 hover:border-ws-accent-border hover:text-ws-accent hover:bg-ws-accent-soft transition-all duration-150 min-h-[120px]"
              >
                <svg className="w-7 h-7" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v16m8-8H4" />
                </svg>
                <span className="text-xs font-semibold">새 비서 만들기</span>
              </button>
            )}

            {agents.length === 0 && activeTab !== 'personal' && (
              <div className="col-span-full text-center py-8 text-sm text-slate-400">
                {activeTab === 'fav'
                  ? '즐겨찾기한 비서가 없습니다. 비서 카드의 ★을 눌러 추가하세요.'
                  : '해당 카테고리의 비서가 없습니다.'}
              </div>
            )}
          </div>
        )}
      </div>
    </div>
    {editingId && (
      <AgentEditorModal agentId={editingId} onClose={() => setEditingId(null)} onSaved={() => fetchAgents(activeTab)} />
    )}
    </>
  );
}
