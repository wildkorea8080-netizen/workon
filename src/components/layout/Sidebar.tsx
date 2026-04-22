'use client';

import { useState, useEffect, useCallback } from 'react';
import { useSession } from 'next-auth/react';

interface Conversation {
  id: string;
  title: string;
  created_at: string;
  updated_at: string;
  agent?: { name: string } | null;
}

interface SidebarProps {
  selectedConversationId: string | null;
  onConversationSelect: (id: string) => void;
  onNewConversation: () => void;
  refreshTrigger?: number;
}

const AGENT_COLORS = [
  'bg-indigo-500', 'bg-violet-500', 'bg-blue-500',
  'bg-teal-500', 'bg-emerald-500', 'bg-pink-500',
];

function agentColor(name: string) {
  let h = 0;
  for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) & 0xffffff;
  return AGENT_COLORS[Math.abs(h) % AGENT_COLORS.length];
}

type DateGroup = '오늘' | '어제' | '이번 주' | '이전';

function getDateGroup(dateStr: string): DateGroup {
  const diff = (Date.now() - new Date(dateStr).getTime()) / 3_600_000;
  if (diff < 24) return '오늘';
  if (diff < 48) return '어제';
  if (diff < 168) return '이번 주';
  return '이전';
}

const GROUP_ORDER: DateGroup[] = ['오늘', '어제', '이번 주', '이전'];

export default function Sidebar({
  selectedConversationId,
  onConversationSelect,
  onNewConversation,
  refreshTrigger,
}: SidebarProps) {
  const { data: session } = useSession();
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [loading, setLoading] = useState(true);
  const [searchTerm, setSearchTerm] = useState('');
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState('');

  const load = useCallback(async () => {
    try {
      const res = await fetch('/api/conversations?limit=80');
      const result = await res.json();
      if (result.ok) setConversations(result.data ?? []);
    } catch {
      // silent
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load, refreshTrigger]);

  const handleDelete = async (id: string, e: React.MouseEvent) => {
    e.stopPropagation();
    if (!confirm('이 대화를 삭제하시겠습니까?')) return;
    try {
      await fetch(`/api/conversations/${id}`, { method: 'DELETE' });
      setConversations(prev => prev.filter(c => c.id !== id));
      if (selectedConversationId === id) onNewConversation();
    } catch {
      alert('삭제에 실패했습니다.');
    }
  };

  const startRename = (c: Conversation, e: React.MouseEvent) => {
    e.stopPropagation();
    setRenamingId(c.id);
    setRenameValue(c.title);
  };

  const submitRename = async (id: string) => {
    if (!renameValue.trim()) { setRenamingId(null); return; }
    try {
      await fetch(`/api/conversations/${id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title: renameValue.trim() }),
      });
      setConversations(prev => prev.map(c => c.id === id ? { ...c, title: renameValue.trim() } : c));
    } catch {
      // silent
    } finally {
      setRenamingId(null);
    }
  };

  const filtered = conversations.filter(c =>
    c.title.toLowerCase().includes(searchTerm.toLowerCase())
  );

  const grouped = GROUP_ORDER.reduce<Record<DateGroup, Conversation[]>>(
    (acc, g) => { acc[g] = []; return acc; },
    {} as Record<DateGroup, Conversation[]>
  );
  filtered.forEach(c => { grouped[getDateGroup(c.updated_at)].push(c); });

  const userName = session?.user?.name || session?.user?.email?.split('@')[0] || '사용자';
  const userInitial = userName.slice(0, 1).toUpperCase();

  return (
    <aside className="w-60 flex-shrink-0 bg-[#1C2B4A] flex flex-col h-full overflow-hidden">
      {/* 새 대화 버튼 */}
      <div className="p-3 pt-4">
        <button
          onClick={onNewConversation}
          className="w-full flex items-center justify-center gap-2 py-2.5 border border-white/30 rounded-xl text-white text-sm font-semibold hover:bg-white/10 transition-colors"
        >
          <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M12 4v16m8-8H4" />
          </svg>
          새 대화
        </button>
      </div>

      {/* 검색 */}
      <div className="px-3 pb-2">
        <div className="relative">
          <svg className="absolute left-2.5 top-2.5 w-3.5 h-3.5 text-white/30" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
          </svg>
          <input
            type="text"
            placeholder="대화 검색..."
            value={searchTerm}
            onChange={e => setSearchTerm(e.target.value)}
            className="w-full bg-white/10 border border-white/10 text-white placeholder-white/30 pl-8 pr-3 py-2 rounded-lg text-xs focus:outline-none focus:ring-1 focus:ring-white/30"
          />
        </div>
      </div>

      {/* 대화 목록 */}
      <div className="flex-1 overflow-y-auto px-2 pb-2 space-y-3 scrollbar-thin scrollbar-track-transparent scrollbar-thumb-white/10">
        {loading ? (
          <p className="text-white/30 text-xs text-center py-6">불러오는 중...</p>
        ) : filtered.length === 0 ? (
          <p className="text-white/30 text-xs text-center py-6">대화가 없습니다.</p>
        ) : (
          GROUP_ORDER.map(group =>
            grouped[group].length > 0 ? (
              <div key={group}>
                <p className="text-[10px] font-semibold text-white/30 uppercase tracking-widest px-1 mb-1">
                  {group}
                </p>
                {grouped[group].map(c => (
                  <ConvItem
                    key={c.id}
                    c={c}
                    selected={selectedConversationId === c.id}
                    onSelect={() => onConversationSelect(c.id)}
                    onDelete={handleDelete}
                    onStartRename={startRename}
                    renamingId={renamingId}
                    renameValue={renameValue}
                    onRenameChange={setRenameValue}
                    onRenameSubmit={submitRename}
                    onRenameCancel={() => setRenamingId(null)}
                  />
                ))}
              </div>
            ) : null
          )
        )}
      </div>

      {/* 하단 프로필 */}
      <div className="p-3 border-t border-white/10 flex items-center gap-2.5">
        <div className="w-8 h-8 rounded-full bg-white/20 flex items-center justify-center text-white text-xs font-bold flex-shrink-0">
          {userInitial}
        </div>
        <div className="flex-1 min-w-0">
          <p className="text-white text-xs font-semibold truncate">{userName}</p>
          <p className="text-white/40 text-[10px] truncate">{session?.user?.email}</p>
        </div>
      </div>
    </aside>
  );
}

interface ConvItemProps {
  c: Conversation;
  selected: boolean;
  onSelect: () => void;
  onDelete: (id: string, e: React.MouseEvent) => void;
  onStartRename: (c: Conversation, e: React.MouseEvent) => void;
  renamingId: string | null;
  renameValue: string;
  onRenameChange: (v: string) => void;
  onRenameSubmit: (id: string) => void;
  onRenameCancel: () => void;
}

function ConvItem({
  c, selected, onSelect, onDelete, onStartRename,
  renamingId, renameValue, onRenameChange, onRenameSubmit, onRenameCancel,
}: ConvItemProps) {
  const isRenaming = renamingId === c.id;
  const color = agentColor(c.agent?.name || '?');

  return (
    <div
      onClick={!isRenaming ? onSelect : undefined}
      className={`group flex items-start gap-2 px-2 py-2 rounded-lg cursor-pointer transition-colors ${
        selected ? 'bg-white/15' : 'hover:bg-white/8'
      }`}
    >
      <div className={`w-6 h-6 rounded-md ${color} flex items-center justify-center text-white text-[10px] font-bold flex-shrink-0 mt-0.5`}>
        {(c.agent?.name || '?').slice(0, 1)}
      </div>

      <div className="flex-1 min-w-0">
        {isRenaming ? (
          <input
            autoFocus
            value={renameValue}
            onChange={e => onRenameChange(e.target.value)}
            onBlur={() => onRenameSubmit(c.id)}
            onKeyDown={e => {
              if (e.key === 'Enter') onRenameSubmit(c.id);
              if (e.key === 'Escape') onRenameCancel();
            }}
            onClick={e => e.stopPropagation()}
            className="w-full bg-white/20 text-white text-xs rounded px-1.5 py-0.5 focus:outline-none focus:ring-1 focus:ring-white/40"
          />
        ) : (
          <p className="text-white text-xs truncate leading-tight">{c.title}</p>
        )}
      </div>

      {/* 호버 액션 아이콘 */}
      {!isRenaming && (
        <div className="flex items-center gap-0.5 opacity-0 group-hover:opacity-100 transition-opacity flex-shrink-0">
          <button
            onClick={e => onStartRename(c, e)}
            className="w-5 h-5 flex items-center justify-center rounded hover:bg-white/20 text-white/50 hover:text-white transition-colors"
            title="이름 변경"
          >
            <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z" />
            </svg>
          </button>
          <button
            onClick={e => onDelete(c.id, e)}
            className="w-5 h-5 flex items-center justify-center rounded hover:bg-red-500/30 text-white/50 hover:text-red-300 transition-colors"
            title="삭제"
          >
            <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
            </svg>
          </button>
        </div>
      )}
    </div>
  );
}
