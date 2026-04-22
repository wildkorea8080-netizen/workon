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
    setMessages(prev => [...prev, userMsg]);
    setInputMessage('');
    setIsLoading(true);

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
      const result = await res.json();

      if (!result.ok) {
        setMessages(prev => [...prev, {
          id: String(Date.now() + 1), role: 'assistant', content: '',
          error: result.error?.message || '오류가 발생했습니다.',
        }]);
        return;
      }

      if (!conversationId && result.data.conversation_id) {
        onConversationCreated(result.data.conversation_id);
        prevConvIdRef.current = result.data.conversation_id;
      }

      setMessages(prev => [...prev, {
        id: String(Date.now() + 1),
        role: 'assistant',
        content: result.data.response,
        sources: result.data.chunks,
      }]);
    } catch {
      setMessages(prev => [...prev, {
        id: String(Date.now() + 1), role: 'assistant', content: '',
        error: '네트워크 오류가 발생했습니다.',
      }]);
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
        <div className="flex items-end gap-3 bg-slate-50 border border-slate-200 rounded-2xl px-4 py-3 focus-within:border-brand-400 focus-within:ring-2 focus-within:ring-brand-100 transition-all">
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
