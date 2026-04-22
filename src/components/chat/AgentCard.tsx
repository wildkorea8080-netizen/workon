'use client';

import type { Agent } from '@/lib/db';

const AVATAR_COLORS = [
  { bg: 'bg-indigo-500', light: 'bg-indigo-50', border: 'border-indigo-300', text: 'text-indigo-700' },
  { bg: 'bg-violet-500', light: 'bg-violet-50', border: 'border-violet-300', text: 'text-violet-700' },
  { bg: 'bg-blue-500',   light: 'bg-blue-50',   border: 'border-blue-300',   text: 'text-blue-700'   },
  { bg: 'bg-teal-500',   light: 'bg-teal-50',   border: 'border-teal-300',   text: 'text-teal-700'   },
  { bg: 'bg-emerald-500',light: 'bg-emerald-50', border: 'border-emerald-300',text: 'text-emerald-700'},
  { bg: 'bg-pink-500',   light: 'bg-pink-50',   border: 'border-pink-300',   text: 'text-pink-700'   },
];

export function pickColor(name: string) {
  let h = 0;
  for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) & 0xffffff;
  return AVATAR_COLORS[Math.abs(h) % AVATAR_COLORS.length];
}

interface AgentCardProps {
  agent: Agent;
  isFavorite: boolean;
  onFavoriteToggle: (agentId: string) => void;
  onSelect: (agent: Agent) => void;
}

export default function AgentCard({ agent, isFavorite, onFavoriteToggle, onSelect }: AgentCardProps) {
  const c = pickColor(agent.name);

  return (
    <div
      className={`group relative flex flex-col gap-3 p-4 bg-white border rounded-xl cursor-pointer transition-all duration-150 hover:shadow-md hover:border-brand-300 ${c.border}`}
      onClick={() => onSelect(agent)}
    >
      {/* 즐겨찾기 버튼 */}
      <button
        onClick={e => { e.stopPropagation(); onFavoriteToggle(agent.id); }}
        className="absolute top-3 right-3 p-1 rounded-lg hover:bg-slate-100 transition-colors"
        aria-label={isFavorite ? '즐겨찾기 해제' : '즐겨찾기 추가'}
      >
        {isFavorite ? (
          <svg className="w-4 h-4 text-amber-400" fill="currentColor" viewBox="0 0 24 24">
            <path d="M12 2l3.09 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77l-6.18 3.25L7 14.14 2 9.27l6.91-1.01L12 2z" />
          </svg>
        ) : (
          <svg className="w-4 h-4 text-slate-300 group-hover:text-slate-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 2l3.09 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77l-6.18 3.25L7 14.14 2 9.27l6.91-1.01L12 2z" />
          </svg>
        )}
      </button>

      {/* 아바타 */}
      <div className={`w-10 h-10 rounded-xl ${c.bg} flex items-center justify-center text-white text-base font-bold flex-shrink-0`}>
        {agent.icon ?? agent.name.slice(0, 1)}
      </div>

      {/* 이름 */}
      <div>
        <p className="text-sm font-semibold text-slate-900 leading-tight pr-6">{agent.name}</p>
        {agent.description && (
          <p className="text-xs text-slate-500 mt-0.5 line-clamp-2">{agent.description}</p>
        )}
      </div>

      {/* 카테고리 뱃지 */}
      {agent.category && agent.category !== '전체' && (
        <span className={`self-start px-2 py-0.5 rounded-full text-xs font-medium ${c.light} ${c.text}`}>
          {agent.category}
        </span>
      )}

      {/* 호버 CTA */}
      <div className="absolute inset-x-0 bottom-0 flex items-center justify-center py-2 opacity-0 group-hover:opacity-100 transition-opacity bg-gradient-to-t from-white/90 to-transparent rounded-b-xl pointer-events-none">
        <span className="text-xs font-semibold text-brand-600">대화 시작 →</span>
      </div>
    </div>
  );
}
