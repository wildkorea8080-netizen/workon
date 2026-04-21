import { useState, useEffect } from 'react';

interface Conversation {
  id: string;
  title: string;
  created_at: string;
  updated_at: string;
  agent: {
    name: string;
  };
}

interface ConversationSidebarProps {
  selectedConversationId: string | null;
  onConversationSelect: (conversationId: string | null) => void;
  onNewConversation: () => void;
}

export default function ConversationSidebar({
  selectedConversationId,
  onConversationSelect,
  onNewConversation,
}: ConversationSidebarProps) {
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [searchTerm, setSearchTerm] = useState('');
  const [filterAgent, setFilterAgent] = useState<string | null>(null);

  useEffect(() => {
    fetchConversations();
  }, []);

  const fetchConversations = async () => {
    try {
      const response = await fetch('/api/conversations?limit=50');
      const result = await response.json();

      if (!result.ok) {
        throw new Error(result.error?.message || '대화 목록을 불러올 수 없습니다.');
      }

      setConversations(result.data);
    } catch (err) {
      setError(err instanceof Error ? err.message : '알 수 없는 오류');
    } finally {
      setLoading(false);
    }
  };

  const formatDate = (dateString: string) => {
    const date = new Date(dateString);
    const now = new Date();
    const diffInHours = (now.getTime() - date.getTime()) / (1000 * 60 * 60);

    if (diffInHours < 24) {
      return date.toLocaleTimeString('ko-KR', {
        hour: '2-digit',
        minute: '2-digit',
      });
    } else if (diffInHours < 24 * 7) {
      return `${Math.floor(diffInHours / 24)}일 전`;
    } else {
      return date.toLocaleDateString('ko-KR', {
        month: 'short',
        day: 'numeric',
      });
    }
  };

  const getAgentColor = (agentName: string) => {
    const colors: Record<string, { bg: string; text: string; dot: string }> = {
      '인사규정': { bg: 'bg-blue-50', text: 'text-blue-700', dot: 'bg-blue-500' },
      '비서': { bg: 'bg-purple-50', text: 'text-purple-700', dot: 'bg-purple-500' },
      '보고서': { bg: 'bg-green-50', text: 'text-green-700', dot: 'bg-green-500' },
    };
    return colors[agentName] || { bg: 'bg-gray-50', text: 'text-gray-700', dot: 'bg-gray-500' };
  };

  // 필터링된 대화 목록
  const filteredConversations = conversations.filter((conv) => {
    const matchesSearch = conv.title.toLowerCase().includes(searchTerm.toLowerCase());
    const matchesFilter = !filterAgent || conv.agent?.name === filterAgent;
    return matchesSearch && matchesFilter;
  });

  // 고유한 에이전트 목록
  const uniqueAgents = Array.from(
    new Set(conversations.map((conv) => conv.agent?.name || '알 수 없는 에이전트'))
  );

  // 최근 대화 (24시간 이내)
  const recentConversations = filteredConversations.filter((conv) => {
    const diffInHours = (new Date().getTime() - new Date(conv.updated_at).getTime()) / (1000 * 60 * 60);
    return diffInHours < 24;
  });

  // 이전 대화
  const olderConversations = filteredConversations.filter((conv) => {
    const diffInHours = (new Date().getTime() - new Date(conv.updated_at).getTime()) / (1000 * 60 * 60);
    return diffInHours >= 24;
  });

  return (
    <div className="w-80 bg-white border-r border-slate-200 flex flex-col">
      {/* Header */}
      <div className="p-4 border-b border-slate-200 space-y-3">
        <button
          onClick={onNewConversation}
          className="w-full bg-blue-600 text-white px-4 py-2 rounded-lg hover:bg-blue-700 transition-colors flex items-center justify-center space-x-2 font-medium"
        >
          <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v16m8-8H4" />
          </svg>
          <span>새 대화</span>
        </button>

        {/* Search */}
        <div className="relative">
          <svg
            className="absolute left-3 top-2.5 w-4 h-4 text-slate-400"
            fill="none"
            stroke="currentColor"
            viewBox="0 0 24 24"
          >
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeWidth={2}
              d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z"
            />
          </svg>
          <input
            type="text"
            placeholder="대화 검색..."
            value={searchTerm}
            onChange={(e) => setSearchTerm(e.target.value)}
            className="w-full pl-9 pr-3 py-2 text-sm border border-slate-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent"
          />
        </div>
      </div>

      {/* Filter Tags */}
      {uniqueAgents.length > 1 && (
        <div className="px-4 pt-3 pb-2 border-b border-slate-200">
          <div className="text-xs font-semibold text-slate-600 mb-2">에이전트</div>
          <div className="flex flex-wrap gap-2">
            <button
              onClick={() => setFilterAgent(null)}
              className={`px-2 py-1 rounded text-xs font-medium transition-colors ${
                filterAgent === null
                  ? 'bg-blue-100 text-blue-700'
                  : 'bg-slate-100 text-slate-600 hover:bg-slate-200'
              }`}
            >
              전체
            </button>
            {uniqueAgents.map((agent) => {
              const colors = getAgentColor(agent);
              return (
                <button
                  key={agent}
                  onClick={() => setFilterAgent(agent)}
                  className={`px-2 py-1 rounded text-xs font-medium transition-colors ${
                    filterAgent === agent ? `${colors.bg} ${colors.text}` : 'bg-slate-100 text-slate-600 hover:bg-slate-200'
                  }`}
                >
                  {agent}
                </button>
              );
            })}
          </div>
        </div>
      )}

      {/* Conversations List */}
      <div className="flex-1 overflow-y-auto">
        {loading ? (
          <div className="p-4 text-center text-slate-500">
            <div className="text-sm">대화 목록 로딩 중...</div>
          </div>
        ) : error ? (
          <div className="p-4 text-center text-red-500">
            <div className="text-sm">{error}</div>
          </div>
        ) : filteredConversations.length === 0 ? (
          <div className="p-4 text-center text-slate-500">
            <div className="text-sm">대화가 없습니다.</div>
            <div className="text-xs mt-1">새 대화를 시작해보세요.</div>
          </div>
        ) : (
          <div className="p-2 space-y-3">
            {/* 최근 대화 */}
            {recentConversations.length > 0 && (
              <div>
                <div className="px-3 py-1.5 text-xs font-semibold text-slate-600 uppercase tracking-wide">
                  🕐 최근
                </div>
                <div className="space-y-1">
                  {recentConversations.map((conversation) => {
                    const colors = getAgentColor(conversation.agent?.name);
                    return (
                      <ConversationItem
                        key={conversation.id}
                        conversation={conversation}
                        isSelected={selectedConversationId === conversation.id}
                        onSelect={() => onConversationSelect(conversation.id)}
                        colors={colors}
                        formatDate={formatDate}
                      />
                    );
                  })}
                </div>
              </div>
            )}

            {/* 이전 대화 */}
            {olderConversations.length > 0 && (
              <div>
                <div className="px-3 py-1.5 text-xs font-semibold text-slate-600 uppercase tracking-wide">
                  📅 이전
                </div>
                <div className="space-y-1">
                  {olderConversations.map((conversation) => {
                    const colors = getAgentColor(conversation.agent?.name);
                    return (
                      <ConversationItem
                        key={conversation.id}
                        conversation={conversation}
                        isSelected={selectedConversationId === conversation.id}
                        onSelect={() => onConversationSelect(conversation.id)}
                        colors={colors}
                        formatDate={formatDate}
                      />
                    );
                  })}
                </div>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

// 대화 아이템 컴포넌트
function ConversationItem({
  conversation,
  isSelected,
  onSelect,
  colors,
  formatDate,
}: {
  conversation: Conversation;
  isSelected: boolean;
  onSelect: () => void;
  colors: { bg: string; text: string; dot: string };
  formatDate: (date: string) => string;
}) {
  return (
    <div
      onClick={onSelect}
      className={`p-2.5 rounded-lg cursor-pointer transition-all ${
        isSelected ? `${colors.bg} border border-current ${colors.text} shadow-sm` : 'hover:bg-slate-50'
      }`}
    >
      <div className="flex items-start justify-between gap-2">
        <div className="flex-1 min-w-0 flex items-start gap-2">
          <div className={`w-2 h-2 rounded-full ${colors.dot} mt-1.5 flex-shrink-0`}></div>
          <div className="flex-1 min-w-0">
            <div className={`text-sm font-medium truncate ${isSelected ? colors.text : 'text-slate-900'}`}>
              {conversation.title}
            </div>
            <div className={`text-xs mt-0.5 ${isSelected ? 'opacity-70' : 'text-slate-500'}`}>
              {conversation.agent?.name || '알 수 없음'}
            </div>
          </div>
        </div>
        <div className={`text-xs flex-shrink-0 ${isSelected ? 'opacity-70' : 'text-slate-500'}`}>
          {formatDate(conversation.updated_at)}
        </div>
      </div>
    </div>
  );
}