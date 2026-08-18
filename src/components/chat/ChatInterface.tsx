'use client';

import { useState, useRef, useEffect } from 'react';
import MessageBubble from './MessageBubble';
import type { Agent, RetrievedChunk } from '@/lib/db';

interface Message {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  sources?: RetrievedChunk[];
  error?: string;
}

const AVATAR_COLORS = [
  'bg-indigo-500', 'bg-violet-500', 'bg-blue-500',
  'bg-teal-500', 'bg-emerald-500', 'bg-pink-500',
];
function pickBg(name: string) {
  let h = 0;
  for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) & 0xffffff;
  return AVATAR_COLORS[Math.abs(h) % AVATAR_COLORS.length];
}

export interface ChatInterfaceProps {
  selectedAgent: Agent;
  conversationId: string | null;
  onConversationCreated: (id: string) => void;
  onChangeAgent: () => void;
}

export default function ChatInterface({
  selectedAgent,
  conversationId,
  onConversationCreated,
  onChangeAgent,
}: ChatInterfaceProps) {
  const [messages, setMessages] = useState<Message[]>([]);
  const [inputMessage, setInputMessage] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const [loadingConv, setLoadingConv] = useState(false);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const prevConvIdRef = useRef<string | null>(null);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

  useEffect(() => {
    const ta = textareaRef.current;
    if (!ta) return;
    ta.style.height = 'auto';
    ta.style.height = `${Math.min(ta.scrollHeight, 140)}px`;
  }, [inputMessage]);

  // conversationId가 바뀌면 메시지 로드
  useEffect(() => {
    if (conversationId === prevConvIdRef.current) return;
    prevConvIdRef.current = conversationId;

    if (!conversationId) {
      setMessages([]);
      return;
    }

    setLoadingConv(true);
    fetch(`/api/conversations/${conversationId}`)
      .then(r => r.json())
      .then(result => {
        if (!result.ok) return;
        setMessages(
          (result.data.messages ?? []).map((m: { id: string; role: 'user' | 'assistant'; content: string; sources?: RetrievedChunk[] }) => ({
            id: m.id, role: m.role, content: m.content, sources: m.sources,
          }))
        );
      })
      .catch(() => {})
      .finally(() => setLoadingConv(false));
  }, [conversationId]);

  // 에이전트가 바뀌면 메시지 초기화
  useEffect(() => {
    if (!conversationId) setMessages([]);
  }, [selectedAgent.id, conversationId]);

  const handleSendMessage = async () => {
    if (!inputMessage.trim() || isLoading) return;

    const userMsg: Message = { id: Date.now().toString(), role: 'user', content: inputMessage.trim() };
    const assistantId = String(Date.now() + 1);

    setMessages(prev => [...prev, userMsg]);
    setInputMessage('');
    setIsLoading(true);

    const patchAssistant = (patch: Partial<Message>) =>
      setMessages(prev =>
        prev.map(m => (m.id === assistantId ? { ...m, ...patch } : m))
      );

    try {
      const res = await fetch('/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          agent_id: selectedAgent.id,
          message: userMsg.content,
          conversation_id: conversationId,
        }),
      });

      // 스트림 시작 전 실패는 JSON으로 돌아온다
      if (!res.body || !res.headers.get('content-type')?.includes('text/event-stream')) {
        const result = await res.json().catch(() => null);
        setMessages(prev => [...prev, {
          id: assistantId, role: 'assistant', content: '',
          error: result?.error?.message || '오류가 발생했습니다.',
        }]);
        return;
      }

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      let streamed = '';
      let pendingSources: RetrievedChunk[] | undefined;
      let bubbleShown = false;

      // 첫 텍스트가 도착하는 순간 말풍선을 만든다.
      // 그 전까지는 로딩 인디케이터가 계속 보인다.
      const showBubble = () => {
        bubbleShown = true;
        setIsLoading(false);
        setMessages(prev => [
          ...prev,
          { id: assistantId, role: 'assistant', content: streamed, sources: pendingSources },
        ]);
      };

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });

        // SSE 이벤트는 빈 줄로 구분된다. 마지막 조각은 불완전할 수 있어 남겨둔다.
        const events = buffer.split('\n\n');
        buffer = events.pop() ?? '';

        for (const raw of events) {
          const eventLine = raw.split('\n').find(l => l.startsWith('event:'));
          const dataLine = raw.split('\n').find(l => l.startsWith('data:'));
          if (!eventLine || !dataLine) continue;

          const name = eventLine.slice(6).trim();
          let payload: any;
          try {
            payload = JSON.parse(dataLine.slice(5).trim());
          } catch {
            continue;
          }

          if (name === 'meta') {
            if (!conversationId && payload.conversation_id) {
              onConversationCreated(payload.conversation_id);
              prevConvIdRef.current = payload.conversation_id;
            }
            if (payload.chunks?.length) {
              pendingSources = payload.chunks;
              if (bubbleShown) patchAssistant({ sources: payload.chunks });
            }
          } else if (name === 'delta') {
            streamed += payload.text;
            if (!bubbleShown) showBubble();
            else patchAssistant({ content: streamed });
          } else if (name === 'error') {
            if (!bubbleShown) {
              setIsLoading(false);
              setMessages(prev => [...prev, {
                id: assistantId, role: 'assistant', content: streamed,
                error: payload.message || '오류가 발생했습니다.',
              }]);
              bubbleShown = true;
            } else {
              patchAssistant({ error: payload.message || '오류가 발생했습니다.' });
            }
          }
        }
      }
    } catch {
      setMessages(prev => {
        const exists = prev.some(m => m.id === assistantId);
        const errored: Message = {
          id: assistantId, role: 'assistant', content: '',
          error: '네트워크 오류가 발생했습니다.',
        };
        return exists
          ? prev.map(m => (m.id === assistantId ? { ...m, error: errored.error } : m))
          : [...prev, errored];
      });
    } finally {
      setIsLoading(false);
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSendMessage();
    }
  };

  const bg = pickBg(selectedAgent.name);

  return (
    <div className="flex flex-col h-full">
      {/* 헤더 */}
      <div className="flex items-center gap-3 px-5 py-3 border-b border-slate-100 bg-white flex-shrink-0">
        <div className={`w-8 h-8 rounded-lg ${bg} flex items-center justify-center text-white text-sm font-bold flex-shrink-0`}>
          {selectedAgent.icon ?? selectedAgent.name.slice(0, 1)}
        </div>
        <div className="flex-1 min-w-0">
          <p className="text-sm font-semibold text-slate-900 leading-tight">{selectedAgent.name}</p>
          {selectedAgent.description && (
            <p className="text-xs text-slate-400 truncate">{selectedAgent.description}</p>
          )}
        </div>
        <button
          onClick={onChangeAgent}
          className="flex-shrink-0 text-xs text-brand-600 hover:text-brand-700 font-semibold px-2.5 py-1 rounded-lg hover:bg-brand-50 transition-colors"
        >
          다른 비서 선택
        </button>
      </div>

      {/* 메시지 영역 */}
      <div className="flex-1 overflow-y-auto px-5 py-5 space-y-1 bg-[#F5F7FA]">
        {loadingConv ? (
          <div className="flex items-center justify-center h-full">
            <div className="w-5 h-5 border-2 border-brand-400 border-t-transparent rounded-full animate-spin" />
          </div>
        ) : messages.length === 0 ? (
          <div className="flex flex-col items-center justify-center h-full text-center space-y-3 pb-16">
            <div className={`w-14 h-14 rounded-2xl ${bg} flex items-center justify-center text-white text-2xl font-bold shadow-lg`}>
              {selectedAgent.icon ?? selectedAgent.name.slice(0, 1)}
            </div>
            <div>
              <p className="text-base font-semibold text-slate-800">{selectedAgent.name}</p>
              <p className="text-sm text-slate-400 mt-1">{selectedAgent.description || '무엇이든 질문해보세요.'}</p>
            </div>
          </div>
        ) : (
          messages.map(msg => (
            <MessageBubble
              key={msg.id}
              role={msg.role}
              content={msg.content}
              sources={msg.sources}
              error={msg.error}
            />
          ))
        )}

        {isLoading && (
          <div className="flex justify-start mb-4">
            <div className="flex items-center gap-3">
              <div className={`w-7 h-7 rounded-lg ${bg} flex items-center justify-center text-white text-xs font-bold flex-shrink-0`}>
                {selectedAgent.icon ?? selectedAgent.name.slice(0, 1)}
              </div>
              <div className="bg-white px-4 py-3 rounded-2xl rounded-tl-sm shadow-sm">
                <div className="flex gap-1.5 items-center">
                  <span className="w-1.5 h-1.5 bg-slate-400 rounded-full animate-bounce" style={{ animationDelay: '0ms' }} />
                  <span className="w-1.5 h-1.5 bg-slate-400 rounded-full animate-bounce" style={{ animationDelay: '150ms' }} />
                  <span className="w-1.5 h-1.5 bg-slate-400 rounded-full animate-bounce" style={{ animationDelay: '300ms' }} />
                </div>
              </div>
            </div>
          </div>
        )}
        <div ref={messagesEndRef} />
      </div>

      {/* 입력 영역 */}
      <div className="px-5 py-4 bg-white border-t border-slate-100 flex-shrink-0">
        <div className="flex items-end gap-3 bg-slate-50 border border-slate-200 rounded-2xl px-4 py-3 focus-within:border-[#003087] focus-within:ring-2 focus-within:ring-[#003087]/10 transition-all">
          <textarea
            ref={textareaRef}
            value={inputMessage}
            onChange={e => setInputMessage(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder={`${selectedAgent.name}에게 질문하세요...`}
            disabled={isLoading}
            rows={1}
            className="flex-1 bg-transparent text-sm text-slate-900 placeholder-slate-400 resize-none focus:outline-none leading-relaxed"
            style={{ minHeight: '24px', maxHeight: '140px' }}
          />
          <button
            onClick={handleSendMessage}
            disabled={!inputMessage.trim() || isLoading}
            className="flex-shrink-0 w-9 h-9 rounded-xl bg-[#003087] hover:bg-[#002070] disabled:bg-slate-200 disabled:cursor-not-allowed text-white flex items-center justify-center transition-colors"
          >
            {isLoading ? (
              <svg className="w-4 h-4 animate-spin" fill="none" viewBox="0 0 24 24">
                <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v8H4z" />
              </svg>
            ) : (
              <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M5 12h14M12 5l7 7-7 7" />
              </svg>
            )}
          </button>
        </div>
        <p className="text-xs text-slate-400 mt-2 text-center">Enter로 전송 · Shift+Enter로 줄바꿈</p>
      </div>
    </div>
  );
}
