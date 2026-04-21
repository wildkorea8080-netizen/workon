'use client';

import { useState, useEffect } from 'react';

interface Conversation {
  id: string;
  title: string;
  created_at: string;
  updated_at: string;
  agent: { name: string };
}

interface ConversationSidebarProps {
  selectedConversationId: string | null;
  onConversationSelect: (id: string | null) => void;
  onNewConversation: () => void;
}

const AVATAR_COLORS = [
  'bg-indigo-500', 'bg-violet-500', 'bg-blue-500',
  'bg-teal-500', 'bg-emerald-500', 'bg-pink-500',
];

function agentColor(name: string) {
  let hash = 0;
  for (let i = 0; i < name.length; i++) hash = (hash * 31 + name.charCodeAt(i)) & 0xffffff;
  return AVATAR_COLORS[Math.abs(hash) % AVATAR_COLORS.length];
}

function formatDate(dateString: string) {
  const date = new Date(dateString);
  const diffH = (Date.now() - date.getTime()) / 3_600_000;
  if (diffH < 24) return date.toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit' });
  if (diffH < 168) return `${Math.floor(diffH / 24)}일 전`;
  return date.toLocaleDateString('ko-KR', { month: 'short', day: 'numeric' });
}

export default function ConversationSidebar({
  selectedConversationId,
  onConversationSelect,
  onNewConversation,
}: ConversationSidebarProps) {
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [loading, setLoading] = useState(true);
  const [searchTerm, setSearchTerm] = useState('');
  const [filterAgent, setFilterAgent] = useState<string | null>(null);

  useEffect(() => {
    fetch('/api/conversations?limit=50')
      .then(r => r.json())
      .then(result => { if (result.ok) setConversations(result.data); })
      .catch(() => {})
      .finally(() => setLoading(false));
  }, []);

  const uniqueAgents = Array.from(new Set(conversations.map(c => c.agent?.name || '알 수 없음')));

  const filtered = conversations.filter(c => {
    const matchSearch = c.title.toLowerCase().includes(searchTerm.toLowerCase());
    const matchAgent = !filterAgent || c.agent?.name === filterAgent;
    return matchSearch && matchAgent;
  });

  const recent = filtered.filter(c => (Date.now() - new Date(c.updated_at).getTime()) < 86_400_000);
  const older  = filtered.filter(c => (Date.now() - new Date(c.updated_at).getTime()) >= 86_400_000);

  return (
    <div className="w-72 bg-[#1a1f36] text-white flex flex-col flex-shrink-0">
      {/* 로고 영역 */}
      <div className="px-5 py-5 border-b border-white/10">
        <span className="text-lg font-bold tracking-tight text-white">WORKON</span>
        <p className="text-xs text-white/40 mt-0.5">AI 업무 비서</p>
      </div>

      {/* 새 대화 버튼 */}
      <div className="px-4 py-4">
        <button
          onClick={onNewConversation}
          className="w-full bg-brand-600 hover:bg-brand-700 text-white px-4 py-2.5 rounded-xl flex items-center justify-center gap-2 text-sm font-semibold transition-colors"
        >
          <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M12 4v16m8-8H4" />
          </svg>
          새 대화 시작
        </button>
      </div>

      {/* 검색 */}
      <div className="px-4 pb-3">
        <div className="relative">
          <svg className="absolute left-3 top-2.5 w-4 h-4 text-white/30" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
          </svg>
          <input
            type="text"
            placeholder="대화 검색..."
            value={searchTerm}
            onChange={e => setSearchTerm(e.target.value)}
            className="w-full bg-white/10 border border-white/10 text-white placeholder-white/30 pl-9 pr-3 py-2 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-brand-500 focus:border-transparent"
          />
        </div>
      </div>

      {/* 에이전트 필터 */}
      {uniqueAgents.length > 1 && (
        <div className="px-4 pb-3 flex flex-wrap gap-1.5">
          <button
            onClick={() => setFilterAgent(null)}
            className={`px-2.5 py-1 rounded-full text-xs font-medium transition-colors ${filterAgent === null ? 'bg-brand-600 text-white' : 'bg-white/10 text-white/60 hover:bg-white/20'}`}
          >
            전체
          </button>
          {uniqueAgents.map(a => (
            <button
              key={a}
              onClick={() => setFilterAgent(a)}
              className={`px-2.5 py-1 rounded-full text-xs font-medium transition-colors ${filterAgent === a ? 'bg-brand-600 text-white' : 'bg-white/10 text-white/60 hover:bg-white/20'}`}
            >
              {a}
            </button>
          ))}
        </div>
      )}

      {/* 대화 목록 */}
      <div className="flex-1 overflow-y-auto px-3 pb-4 space-y-4 scrollbar-thin">
        {loading ? (
          <div className="text-center text-white/40 text-sm py-8">불러오는 중...</div>
        ) : filtered.length === 0 ? (
          <div className="text-center text-white/40 text-sm py-8">대화가 없습니다.</div>
        ) : (
          <>
            {recent.length > 0 && (
              <div>
                <p className="text-[11px] font-semibold text-white/40 uppercase tracking-widest px-2 mb-1.5">오늘</p>
                {recent.map(c => <ConvItem key={c.id} c={c} selected={selectedConversationId === c.id} onSelect={() => onConversationSelect(c.id)} />)}
              </div>
            )}
            {older.length > 0 && (
              <div>
                <p className="text-[11px] font-semibold text-white/40 uppercase tracking-widest px-2 mb-1.5">이전 대화</p>
                {older.map(c => <ConvItem key={c.id} c={c} selected={selectedConversationId === c.id} onSelect={() => onConversationSelect(c.id)} />)}
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}

function ConvItem({ c, selected, onSelect }: { c: Conversation; selected: boolean; onSelect: () => void }) {
  const color = agentColor(c.agent?.name || '?');
  return (
    <div
      onClick={onSelect}
      className={`flex items-start gap-2.5 px-2 py-2.5 rounded-lg cursor-pointer transition-colors ${
        selected ? 'bg-brand-600/30 border border-brand-500/40' : 'hover:bg-white/8'
      }`}
    >
      <div className={`w-7 h-7 rounded-lg ${color} flex items-center justify-center text-white text-[11px] font-bold flex-shrink-0 mt-0.5`}>
        {(c.agent?.name || '?').slice(0, 1)}
      </div>
      <div className="flex-1 min-w-0">
        <div className="text-sm font-medium text-white truncate leading-tight">{c.title}</div>
        <div className="flex items-center gap-1.5 mt-0.5">
          <span className="text-[11px] text-white/40 truncate">{c.agent?.name || '알 수 없음'}</span>
          <span className="text-white/20 text-[11px]">·</span>
          <span className="text-[11px] text-white/40 flex-shrink-0">{formatDate(c.updated_at)}</span>
        </div>
      </div>
    </div>
  );
}
