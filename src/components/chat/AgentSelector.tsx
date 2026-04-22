'use client';

import { useState, useEffect, useCallback } from 'react';
import type { Agent } from '@/lib/db';
import AgentCard from './AgentCard';

const TABS = [
  { key: 'all',      label: '전체' },
  { key: 'fav',      label: '즐겨찾기', icon: '★' },
  { key: '공공기관', label: '공공기관' },
  { key: '업무',     label: '업무' },
  { key: '문서',     label: '문서' },
  { key: '번역',     label: '번역' },
  { key: 'personal', label: '내 비서' },
] as const;

type TabKey = (typeof TABS)[number]['key'];

interface AgentSelectorProps {
  selectedAgent: Agent | null;
  onAgentSelect: (agent: Agent | null) => void;
  onCreatePersonal?: () => void;
}

export default function AgentSelector({ selectedAgent, onAgentSelect, onCreatePersonal }: AgentSelectorProps) {
  const [activeTab, setActiveTab] = useState<TabKey>('all');
  const [agents, setAgents] = useState<Agent[]>([]);
  const [favoriteIds, setFavoriteIds] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const fetchAgents = useCallback(async (tab: TabKey) => {
    setLoading(true);
    setError(null);
    try {
      let url = '/api/agents';
      if (tab === 'fav') url = '/api/agents?favorites=true';
      else if (tab === 'personal') url = '/api/agents?personal=true';
      else if (tab !== 'all') url = `/api/agents?category=${encodeURIComponent(tab)}`;

      const res = await fetch(url);
      const result = await res.json();
      if (!result.ok) throw new Error(result.error?.message);
      setAgents(result.data ?? []);
      if (result.meta?.favoriteIds) setFavoriteIds(result.meta.favoriteIds);
    } catch (err) {
      setError(err instanceof Error ? err.message : '오류가 발생했습니다.');
    } finally {
      setLoading(false);
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
      const result = await res.json();
      if (!result.ok) return;
      setFavoriteIds(result.data.favoriteIds);
      // 즐겨찾기 탭에서 토글하면 목록에서 제거
      if (activeTab === 'fav' && !result.data.isFavorite) {
        setAgents(prev => prev.filter(a => a.id !== agentId));
      }
    } catch {
      // ignore
    }
  };

  return (
    <div className="flex flex-col border-b border-slate-100 bg-white">
      {/* 탭 바 */}
      <div className="flex items-center gap-0.5 px-4 pt-3 overflow-x-auto scrollbar-none">
        {TABS.map(tab => (
          <button
            key={tab.key}
            onClick={() => handleTabChange(tab.key)}
            className={`flex items-center gap-1 px-3 py-2 text-xs font-semibold rounded-t-lg whitespace-nowrap transition-colors border-b-2 ${
              activeTab === tab.key
                ? 'border-brand-600 text-brand-700 bg-brand-50'
                : 'border-transparent text-slate-500 hover:text-slate-700 hover:bg-slate-50'
            }`}
          >
            {'icon' in tab && <span className="text-amber-400">{tab.icon}</span>}
            {tab.label}
          </button>
        ))}
      </div>

      {/* 컨텐츠 */}
      <div className="p-4">
        {loading ? (
          <div className="text-center py-6 text-sm text-slate-400">
            <div className="inline-block w-5 h-5 border-2 border-brand-400 border-t-transparent rounded-full animate-spin mb-2" />
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
              />
            ))}

            {/* 내 비서 탭: 새 비서 만들기 카드 */}
            {activeTab === 'personal' && (
              <button
                onClick={onCreatePersonal}
                className="flex flex-col items-center justify-center gap-2 p-4 bg-slate-50 border-2 border-dashed border-slate-200 rounded-xl text-slate-400 hover:border-brand-300 hover:text-brand-500 hover:bg-brand-50 transition-all duration-150 min-h-[120px]"
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
  );
}
