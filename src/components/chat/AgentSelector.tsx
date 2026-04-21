'use client';

import { useState, useEffect } from 'react';
import type { Agent } from '@/lib/db';

const AVATAR_COLORS = [
  { bg: 'bg-indigo-500', light: 'bg-indigo-50', border: 'border-indigo-200', text: 'text-indigo-700' },
  { bg: 'bg-violet-500', light: 'bg-violet-50', border: 'border-violet-200', text: 'text-violet-700' },
  { bg: 'bg-blue-500',   light: 'bg-blue-50',   border: 'border-blue-200',   text: 'text-blue-700'   },
  { bg: 'bg-teal-500',   light: 'bg-teal-50',   border: 'border-teal-200',   text: 'text-teal-700'   },
  { bg: 'bg-emerald-500',light: 'bg-emerald-50', border: 'border-emerald-200',text: 'text-emerald-700'},
  { bg: 'bg-pink-500',   light: 'bg-pink-50',   border: 'border-pink-200',   text: 'text-pink-700'   },
];

function pickColor(name: string) {
  let h = 0;
  for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) & 0xffffff;
  return AVATAR_COLORS[Math.abs(h) % AVATAR_COLORS.length];
}

interface AgentSelectorProps {
  selectedAgent: Agent | null;
  onAgentSelect: (agent: Agent | null) => void;
}

export default function AgentSelector({ selectedAgent, onAgentSelect }: AgentSelectorProps) {
  const [agents, setAgents] = useState<Agent[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    fetch('/api/agents')
      .then(r => r.json())
      .then(result => {
        if (!result.ok) throw new Error(result.error?.message);
        setAgents(result.data);
      })
      .catch(err => setError(err instanceof Error ? err.message : '오류'))
      .finally(() => setLoading(false));
  }, []);

  if (loading) {
    return (
      <div className="px-6 py-5 border-b border-slate-100 bg-white">
        <div className="text-sm text-slate-400">비서 목록 불러오는 중...</div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="px-6 py-4 border-b border-slate-100 bg-red-50">
        <div className="text-sm text-red-500">{error}</div>
      </div>
    );
  }

  return (
    <div className="px-6 py-5 border-b border-slate-100 bg-white">
      <p className="text-xs font-semibold text-slate-400 uppercase tracking-wider mb-3">AI 비서 선택</p>
      <div className="flex flex-wrap gap-3">
        {agents.map(agent => {
          const c = pickColor(agent.name);
          const isSelected = selectedAgent?.id === agent.id;
          return (
            <button
              key={agent.id}
              onClick={() => onAgentSelect(isSelected ? null : agent)}
              className={`flex items-center gap-3 px-4 py-3 rounded-xl border-2 transition-all duration-150 text-left group ${
                isSelected
                  ? 'border-brand-600 bg-brand-50 shadow-sm'
                  : `border-transparent ${c.light} hover:border-slate-200 hover:shadow-sm`
              }`}
            >
              {/* 아바타 */}
              <div className={`w-9 h-9 rounded-xl ${c.bg} flex items-center justify-center text-white text-sm font-bold flex-shrink-0`}>
                {agent.name.slice(0, 1)}
              </div>
              {/* 텍스트 */}
              <div>
                <div className={`text-sm font-semibold leading-tight ${isSelected ? 'text-brand-700' : 'text-slate-800'}`}>
                  {agent.name}
                </div>
                {agent.description && (
                  <div className={`text-xs mt-0.5 line-clamp-1 max-w-[160px] ${isSelected ? 'text-brand-500' : 'text-slate-400'}`}>
                    {agent.description}
                  </div>
                )}
              </div>
              {isSelected && (
                <div className="ml-auto flex-shrink-0 w-2 h-2 rounded-full bg-brand-600" />
              )}
            </button>
          );
        })}
      </div>
      {agents.length === 0 && (
        <div className="text-center py-6 text-slate-400 text-sm">
          등록된 비서가 없습니다. 관리자에게 문의하세요.
        </div>
      )}
    </div>
  );
}
