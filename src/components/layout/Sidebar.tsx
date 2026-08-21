'use client';

import { useState, useEffect, useCallback } from 'react';
import { useSession } from 'next-auth/react';

interface Conversation {
  id: string;
  title: string;
  created_at: string;
  updated_at: string;
  /** 공유 중인지. 목록에서 바로 알아야 링크 복사와 중단을 구분해 보여줄 수 있다. */
  is_shared?: boolean;
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
  const [toast, setToast] = useState<string | null>(null);

  const showToast = useCallback((msg: string) => {
    setToast(msg);
    setTimeout(() => setToast(null), 2500);
  }, []);

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

  const handleShare = async (id: string, e: React.MouseEvent) => {
    e.stopPropagation();
    try {
      const res = await fetch(`/api/conversations/${id}/share`, { method: 'POST' });
      const result = await res.json();
      if (!result.ok) throw new Error(result.error?.message);
      await navigator.clipboard.writeText(result.data.shareUrl);
      setConversations(prev =>
        prev.map(c => (c.id === id ? { ...c, is_shared: true } : c))
      );
      showToast('🔗 공유 링크가 복사됐습니다!');
    } catch {
      showToast('공유 링크 생성에 실패했습니다.');
    }
  };

  /**
   * 공유 중단.
   *
   * 되묻는다. 중단하면 주소가 버려져 예전에 링크를 받아 둔 사람도 다시 볼 수
   * 없게 되는데, 실수로 눌렀을 때 되돌릴 방법이 없다. 다시 공유하면 **다른**
   * 주소가 나가므로 이미 배포한 링크를 되살릴 수 없다.
   */
  const handleUnshare = async (id: string, e: React.MouseEvent) => {
    e.stopPropagation();
    const msg =
      '공유를 중단하면 지금 링크는 더 이상 열리지 않습니다. 다시 공유하면 새 주소가 만들어집니다. 중단할까요?';
    if (!confirm(msg)) {
      return;
    }
    try {
      const res = await fetch(`/api/conversations/${id}/share`, { method: 'DELETE' });
      const result = await res.json();
      if (!result.ok) throw new Error(result.error?.message);
      setConversations(prev =>
        prev.map(c => (c.id === id ? { ...c, is_shared: false } : c))
      );
      showToast('공유를 중단했습니다.');
    } catch {
      showToast('공유 중단에 실패했습니다.');
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
    <aside className="w-60 flex-shrink-0 bg-[#1C2B4A] flex flex-col h-full overflow-hidden relative">
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
                    onShare={handleShare}
                    onUnshare={handleUnshare}
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

      {/* 토스트 */}
      {toast && (
        <div className="absolute bottom-16 left-3 right-3 bg-white text-slate-800 text-xs font-medium px-3 py-2.5 rounded-xl shadow-lg text-center animate-fade-in z-10">
          {toast}
        </div>
      )}
    </aside>
  );
}

interface ConvItemProps {
  c: Conversation;
  selected: boolean;
  onSelect: () => void;
  onDelete: (id: string, e: React.MouseEvent) => void;
  onShare: (id: string, e: React.MouseEvent) => void;
  onUnshare: (id: string, e: React.MouseEvent) => void;
  onStartRename: (c: Conversation, e: React.MouseEvent) => void;
  renamingId: string | null;
  renameValue: string;
  onRenameChange: (v: string) => void;
  onRenameSubmit: (id: string) => void;
  onRenameCancel: () => void;
}

function ConvItem({
  c, selected, onSelect, onDelete, onShare, onUnshare, onStartRename,
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
          <p className="text-white text-xs truncate leading-tight">
            {/* 공유 중인 대화를 목록에서 알아볼 수 있어야 한다. 마우스를 올려야
                아이콘이 보이는 구조라 표시가 없으면 공유 사실을 잊는다. */}
            {c.is_shared && <span className="text-emerald-300 mr-1" title="공유 중">🔗</span>}
            {c.title}
          </p>
        )}
      </div>

      {/* 호버 액션 아이콘 */}
      {!isRenaming && (
        <div className="flex items-center gap-0.5 opacity-0 group-hover:opacity-100 transition-opacity flex-shrink-0">
          {/* 이름 변경 */}
          <button
            onClick={e => onStartRename(c, e)}
            className="w-5 h-5 flex items-center justify-center rounded hover:bg-white/20 text-white/50 hover:text-white transition-colors"
            title="이름 변경"
          >
            <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z" />
            </svg>
          </button>
          {/* 공유 중단 — 공유 중일 때만 보인다.
              한 번 공유하면 영구히 열려 있었고 되돌릴 수단이 아예 없었다. */}
          {c.is_shared && (
            <button
              onClick={e => onUnshare(c.id, e)}
              className="w-5 h-5 flex items-center justify-center rounded hover:bg-amber-500/30 text-amber-300 hover:text-amber-200 transition-colors"
              title="공유 중단"
            >
              <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13.875 18.825A10.05 10.05 0 0112 19c-4.478 0-8.268-2.943-9.543-7a9.97 9.97 0 011.563-3.029m5.858.908a3 3 0 114.243 4.243M9.878 9.878l4.242 4.242M9.88 9.88l-3.29-3.29m7.532 7.532l3.29 3.29M3 3l3.59 3.59m0 0A9.953 9.953 0 0112 5c4.478 0 8.268 2.943 9.543 7a10.025 10.025 0 01-4.132 5.411m0 0L21 21" />
              </svg>
            </button>
          )}
          {/* 공유 */}
          <button
            onClick={e => onShare(c.id, e)}
            className={`w-5 h-5 flex items-center justify-center rounded hover:bg-white/20 transition-colors ${
              c.is_shared ? 'text-emerald-300 hover:text-emerald-200' : 'text-white/50 hover:text-white'
            }`}
            title={c.is_shared ? '공유 중 — 링크 다시 복사' : '공유 링크 복사'}
          >
            <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8.684 13.342C8.886 12.938 9 12.482 9 12c0-.482-.114-.938-.316-1.342m0 2.684a3 3 0 110-2.684m0 2.684l6.632 3.316m-6.632-6l6.632-3.316m0 0a3 3 0 105.367-2.684 3 3 0 00-5.367 2.684zm0 9.316a3 3 0 105.368 2.684 3 3 0 00-5.368-2.684z" />
            </svg>
          </button>
          {/* 삭제 */}
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
