'use client';

import { useState, useEffect } from 'react';

interface ConversationSummary {
  id: string;
  title: string | null;
  created_at: string;
  updated_at: string;
  first_message: string | null;
  agent: { name: string } | null;
}

interface ConversationMessage {
  id: string;
  role: string;
  content: string;
  created_at: string;
}

interface ConversationDetail {
  id: string;
  title: string | null;
  agent: { id: string; name: string; description: string } | null;
  messages: ConversationMessage[];
}

export default function ConversationHistory() {
  const [conversations, setConversations] = useState<ConversationSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [detailCache, setDetailCache] = useState<Record<string, ConversationDetail>>({});
  const [detailLoading, setDetailLoading] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    fetch('/api/conversations?limit=50')
      .then((r) => r.json())
      .then((result) => {
        if (result.ok) setConversations(result.data);
        else setError(result.error?.message || '불러오기 실패');
      })
      .catch(() => setError('네트워크 오류가 발생했습니다.'))
      .finally(() => setLoading(false));
  }, []);

  const handleToggle = async (id: string) => {
    if (expandedId === id) {
      setExpandedId(null);
      return;
    }
    setExpandedId(id);
    if (detailCache[id]) return;

    setDetailLoading(id);
    try {
      const res = await fetch(`/api/conversations/${id}`);
      const result = await res.json();
      if (result.ok) {
        setDetailCache((prev) => ({ ...prev, [id]: result.data }));
      }
    } catch {
      // 상세 로드 실패 시 목록은 유지
    } finally {
      setDetailLoading(null);
    }
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center py-16">
        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-slate-600" />
        <span className="ml-3 text-slate-600">불러오는 중...</span>
      </div>
    );
  }

  if (error) {
    return <div className="p-4 text-red-700 bg-red-100 rounded-lg">{error}</div>;
  }

  if (conversations.length === 0) {
    return (
      <div className="text-center py-16 text-slate-500 border rounded-lg bg-slate-50">
        <svg className="w-12 h-12 mx-auto mb-4 text-slate-300" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 10h.01M12 10h.01M16 10h.01M9 16H5a2 2 0 01-2-2V6a2 2 0 012-2h14a2 2 0 012 2v8a2 2 0 01-2 2h-5l-5 5v-5z" />
        </svg>
        <p className="text-sm font-medium">아직 대화 기록이 없습니다.</p>
        <p className="text-xs mt-1">AI Q&amp;A 페이지에서 대화를 시작해보세요.</p>
      </div>
    );
  }

  return (
    <div className="space-y-3">
      {conversations.map((conv) => {
        const isExpanded = expandedId === conv.id;
        const detail = detailCache[conv.id];
        const isLoadingDetail = detailLoading === conv.id;

        return (
          <div key={conv.id} className="border rounded-lg bg-white overflow-hidden">
            {/* 목록 행 */}
            <button
              onClick={() => handleToggle(conv.id)}
              className="w-full text-left p-4 hover:bg-slate-50 transition-colors"
            >
              <div className="flex items-start justify-between gap-4">
                <div className="flex-1 min-w-0">
                  {/* 비서 이름 + 날짜 */}
                  <div className="flex items-center gap-2 mb-1">
                    <span className="text-xs px-2 py-0.5 bg-slate-100 text-slate-600 rounded-full font-medium">
                      {conv.agent?.name ?? '비서 미지정'}
                    </span>
                    <span className="text-xs text-slate-400">
                      {new Date(conv.updated_at).toLocaleDateString('ko-KR', {
                        year: 'numeric',
                        month: 'short',
                        day: 'numeric',
                        hour: '2-digit',
                        minute: '2-digit',
                      })}
                    </span>
                  </div>

                  {/* 대화 제목 */}
                  <p className="font-medium text-slate-900 truncate">
                    {conv.title || '제목 없는 대화'}
                  </p>

                  {/* 첫 메시지 미리보기 */}
                  {conv.first_message && (
                    <p className="text-sm text-slate-500 truncate mt-0.5">
                      {conv.first_message}
                    </p>
                  )}
                </div>

                {/* 펼치기 화살표 */}
                <svg
                  className={`w-4 h-4 text-slate-400 flex-shrink-0 mt-1 transition-transform ${isExpanded ? 'rotate-180' : ''}`}
                  fill="none"
                  stroke="currentColor"
                  viewBox="0 0 24 24"
                >
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
                </svg>
              </div>
            </button>

            {/* 펼쳐진 대화 내용 */}
            {isExpanded && (
              <div className="border-t border-slate-100 bg-slate-50 p-4">
                {isLoadingDetail ? (
                  <div className="flex items-center justify-center py-6">
                    <div className="animate-spin rounded-full h-5 w-5 border-b-2 border-slate-500" />
                    <span className="ml-2 text-sm text-slate-500">대화 내용을 불러오는 중...</span>
                  </div>
                ) : detail ? (
                  <div className="space-y-3 max-h-96 overflow-y-auto">
                    {detail.messages.map((msg) => (
                      <div
                        key={msg.id}
                        className={`flex ${msg.role === 'user' ? 'justify-end' : 'justify-start'}`}
                      >
                        <div
                          className={`max-w-[80%] px-4 py-2.5 rounded-2xl text-sm leading-relaxed ${
                            msg.role === 'user'
                              ? 'bg-slate-900 text-white rounded-br-sm'
                              : 'bg-white border border-slate-200 text-slate-800 rounded-bl-sm'
                          }`}
                        >
                          {msg.role !== 'user' && (
                            <p className="text-xs font-medium text-slate-500 mb-1">
                              {detail.agent?.name ?? 'AI 비서'}
                            </p>
                          )}
                          <p className="whitespace-pre-wrap">{msg.content}</p>
                          <p className={`text-xs mt-1 ${msg.role === 'user' ? 'text-slate-400' : 'text-slate-400'}`}>
                            {new Date(msg.created_at).toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit' })}
                          </p>
                        </div>
                      </div>
                    ))}
                  </div>
                ) : (
                  <p className="text-sm text-slate-500 text-center py-4">대화 내용을 불러올 수 없습니다.</p>
                )}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}
