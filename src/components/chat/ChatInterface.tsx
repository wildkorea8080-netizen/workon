'use client';

import { useState, useRef, useEffect } from 'react';
import AgentSelector from './AgentSelector';
import ConversationSidebar from './ConversationSidebar';
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
  'bg-indigo-500','bg-violet-500','bg-blue-500',
  'bg-teal-500','bg-emerald-500','bg-pink-500',
];
function pickBg(name: string) {
  let h = 0;
  for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) & 0xffffff;
  return AVATAR_COLORS[Math.abs(h) % AVATAR_COLORS.length];
}

export default function ChatInterface() {
  const [selectedAgent, setSelectedAgent] = useState<Agent | null>(null);
  const [showAgentSelector, setShowAgentSelector] = useState(true);
  const [selectedConversationId, setSelectedConversationId] = useState<string | null>(null);
  const [messages, setMessages] = useState<Message[]>([]);
  const [inputMessage, setInputMessage] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const [conversationId, setConversationId] = useState<string | null>(null);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

  // textarea 자동 높이
  useEffect(() => {
    const ta = textareaRef.current;
    if (!ta) return;
    ta.style.height = 'auto';
    ta.style.height = `${Math.min(ta.scrollHeight, 140)}px`;
  }, [inputMessage]);

  const handleNewConversation = () => {
    setSelectedConversationId(null);
    setConversationId(null);
    setMessages([]);
    setSelectedAgent(null);
    setInputMessage('');
    setShowAgentSelector(true);
  };

  const handleConversationSelect = async (id: string | null) => {
    if (!id) return;
    try {
      setSelectedConversationId(id);
      const result = await fetch(`/api/conversations/${id}`).then(r => r.json());
      if (!result.ok) throw new Error(result.error?.message);
      const conv = result.data;
      setConversationId(conv.id);
      setSelectedAgent(conv.agent);
      setShowAgentSelector(false);
      setMessages(
        (conv.messages ?? []).map((m: any) => ({
          id: m.id, role: m.role, content: m.content, sources: m.sources,
        }))
      );
    } catch {
      // silent
    }
  };

  const handleAgentSelect = (agent: Agent | null) => {
    setSelectedAgent(agent);
    if (agent) setShowAgentSelector(false);
  };

  const handleSendMessage = async () => {
    if (!selectedAgent || !inputMessage.trim() || isLoading) return;

    const userMsg: Message = { id: Date.now().toString(), role: 'user', content: inputMessage.trim() };
    setMessages(prev => [...prev, userMsg]);
    setInputMessage('');
    setIsLoading(true);

    try {
      const res = await fetch('/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ agent_id: selectedAgent.id, message: userMsg.content, conversation_id: conversationId }),
      });
      const result = await res.json();

      if (!result.ok) {
        setMessages(prev => [...prev, { id: String(Date.now()+1), role: 'assistant', content: '', error: result.error?.message || '오류가 발생했습니다.' }]);
        return;
      }

      if (!conversationId && result.data.conversation_id) {
        setConversationId(result.data.conversation_id);
        setSelectedConversationId(result.data.conversation_id);
      }

      setMessages(prev => [...prev, {
        id: String(Date.now()+1),
        role: 'assistant',
        content: result.data.response,
        sources: result.data.chunks,
      }]);
    } catch {
      setMessages(prev => [...prev, { id: String(Date.now()+1), role: 'assistant', content: '', error: '네트워크 오류가 발생했습니다.' }]);
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

  return (
    <div className="flex h-screen bg-white overflow-hidden">
      <ConversationSidebar
        selectedConversationId={selectedConversationId}
        onConversationSelect={handleConversationSelect}
        onNewConversation={handleNewConversation}
      />

      <div className="flex-1 flex flex-col min-w-0">
        {/* 상단 헤더 */}
        <header className="flex items-center justify-between px-6 py-3.5 border-b border-slate-100 bg-white flex-shrink-0">
          {selectedAgent ? (
            <div className="flex items-center gap-3">
              <div className={`w-8 h-8 rounded-lg ${pickBg(selectedAgent.name)} flex items-center justify-center text-white text-sm font-bold`}>
                {selectedAgent.name.slice(0, 1)}
              </div>
              <div>
                <div className="text-sm font-semibold text-slate-900 leading-tight">{selectedAgent.name}</div>
                {selectedAgent.description && (
                  <div className="text-xs text-slate-400 leading-tight">{selectedAgent.description}</div>
                )}
              </div>
              <button
                onClick={() => setShowAgentSelector(v => !v)}
                className="ml-2 text-xs text-brand-600 hover:text-brand-700 font-medium"
              >
                변경
              </button>
            </div>
          ) : (
            <div className="text-sm font-semibold text-slate-500">비서를 선택하세요</div>
          )}
          <div className="flex items-center gap-2 text-slate-400">
            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
            </svg>
          </div>
        </header>

        {/* 에이전트 선택 패널 (접이식) */}
        {showAgentSelector && (
          <AgentSelector selectedAgent={selectedAgent} onAgentSelect={handleAgentSelect} />
        )}

        {/* 메시지 영역 */}
        <div className="flex-1 overflow-y-auto px-6 py-6 space-y-1">
          {messages.length === 0 ? (
            <div className="flex flex-col items-center justify-center h-full text-center space-y-3 pb-20">
              {selectedAgent ? (
                <>
                  <div className={`w-14 h-14 rounded-2xl ${pickBg(selectedAgent.name)} flex items-center justify-center text-white text-2xl font-bold shadow-lg`}>
                    {selectedAgent.name.slice(0, 1)}
                  </div>
                  <div>
                    <p className="text-lg font-semibold text-slate-800">{selectedAgent.name}</p>
                    <p className="text-sm text-slate-400 mt-1">{selectedAgent.description || '무엇이든 질문해보세요.'}</p>
                  </div>
                </>
              ) : (
                <>
                  <div className="w-14 h-14 rounded-2xl bg-slate-100 flex items-center justify-center">
                    <svg className="w-7 h-7 text-slate-300" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M8 10h.01M12 10h.01M16 10h.01M9 16H5a2 2 0 01-2-2V6a2 2 0 012-2h14a2 2 0 012 2v8a2 2 0 01-2 2h-5l-5 5v-5z" />
                    </svg>
                  </div>
                  <p className="text-slate-400 text-sm">위에서 AI 비서를 선택하고 대화를 시작하세요.</p>
                </>
              )}
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
                {selectedAgent && (
                  <div className={`w-7 h-7 rounded-lg ${pickBg(selectedAgent.name)} flex items-center justify-center text-white text-xs font-bold flex-shrink-0`}>
                    {selectedAgent.name.slice(0, 1)}
                  </div>
                )}
                <div className="bg-slate-100 px-4 py-3 rounded-2xl rounded-tl-sm">
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
        <div className="px-6 py-4 bg-white border-t border-slate-100 flex-shrink-0">
          <div className="flex items-end gap-3 bg-slate-50 border border-slate-200 rounded-2xl px-4 py-3 focus-within:border-brand-400 focus-within:ring-2 focus-within:ring-brand-100 transition-all">
            <textarea
              ref={textareaRef}
              value={inputMessage}
              onChange={e => setInputMessage(e.target.value)}
              onKeyDown={handleKeyDown}
              placeholder={selectedAgent ? `${selectedAgent.name}에게 질문하세요...` : '비서를 먼저 선택하세요'}
              disabled={!selectedAgent || isLoading}
              rows={1}
              className="flex-1 bg-transparent text-sm text-slate-900 placeholder-slate-400 resize-none focus:outline-none leading-relaxed disabled:opacity-50"
              style={{ minHeight: '24px', maxHeight: '140px' }}
            />
            <button
              onClick={handleSendMessage}
              disabled={!selectedAgent || !inputMessage.trim() || isLoading}
              className="flex-shrink-0 w-9 h-9 rounded-xl bg-brand-600 hover:bg-brand-700 disabled:bg-slate-200 disabled:cursor-not-allowed text-white flex items-center justify-center transition-colors"
            >
              {isLoading ? (
                <svg className="w-4 h-4 animate-spin" fill="none" viewBox="0 0 24 24">
                  <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"/>
                  <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v8H4z"/>
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
    </div>
  );
}
