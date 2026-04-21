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

export default function ChatInterface() {
  const [selectedAgent, setSelectedAgent] = useState<Agent | null>(null);
  const [selectedConversationId, setSelectedConversationId] = useState<string | null>(null);
  const [messages, setMessages] = useState<Message[]>([]);
  const [inputMessage, setInputMessage] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const [conversationId, setConversationId] = useState<string | null>(null);
  const messagesEndRef = useRef<HTMLDivElement>(null);

  const scrollToBottom = () => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  };

  useEffect(() => {
    scrollToBottom();
  }, [messages]);

  const handleNewConversation = () => {
    setSelectedConversationId(null);
    setConversationId(null);
    setMessages([]);
    setSelectedAgent(null);
    setInputMessage('');
  };

  const handleConversationSelect = async (conversationId: string | null) => {
    if (!conversationId) return;
    try {
      setSelectedConversationId(conversationId);
      const response = await fetch(`/api/conversations/${conversationId}`);
      const result = await response.json();

      if (!result.ok) {
        throw new Error(result.error?.message || '대화를 불러올 수 없습니다.');
      }

      const conversation = result.data;
      setConversationId(conversation.id);
      setSelectedAgent(conversation.agent);

      // 메시지 변환
      const conversationMessages: Message[] = conversation.messages?.map((msg: any) => ({
        id: msg.id,
        role: msg.role,
        content: msg.content,
        sources: msg.sources,
      })) || [];

      setMessages(conversationMessages);
    } catch (error) {
      console.error('대화 로드 오류:', error);
      // 에러 처리
    }
  };

  const handleSendMessage = async () => {
    if (!selectedAgent || !inputMessage.trim() || isLoading) return;

    const userMessage: Message = {
      id: Date.now().toString(),
      role: 'user',
      content: inputMessage.trim(),
    };

    setMessages(prev => [...prev, userMessage]);
    setInputMessage('');
    setIsLoading(true);

    try {
      const response = await fetch('/api/chat', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          agent_id: selectedAgent.id,
          message: userMessage.content,
          conversation_id: conversationId,
        }),
      });

      const result = await response.json();

      if (!result.ok) {
        const assistantMessage: Message = {
          id: (Date.now() + 1).toString(),
          role: 'assistant',
          content: '',
          error: result.error?.message || '알 수 없는 오류가 발생했습니다.',
        };
        setMessages(prev => [...prev, assistantMessage]);
        return;
      }

      // Update conversation ID if new
      if (!conversationId && result.data.conversation_id) {
        setConversationId(result.data.conversation_id);
        setSelectedConversationId(result.data.conversation_id);
      }

      const assistantMessage: Message = {
        id: (Date.now() + 1).toString(),
        role: 'assistant',
        content: result.data.response,
        sources: result.data.chunks,
      };

      setMessages(prev => [...prev, assistantMessage]);
    } catch (error) {
      const assistantMessage: Message = {
        id: (Date.now() + 1).toString(),
        role: 'assistant',
        content: '',
        error: '네트워크 오류가 발생했습니다.',
      };
      setMessages(prev => [...prev, assistantMessage]);
    } finally {
      setIsLoading(false);
    }
  };

  const handleKeyPress = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSendMessage();
    }
  };

  return (
    <div className="flex h-screen bg-white">
      <ConversationSidebar
        selectedConversationId={selectedConversationId}
        onConversationSelect={handleConversationSelect}
        onNewConversation={handleNewConversation}
      />

      <div className="flex-1 flex flex-col">
        <AgentSelector
          selectedAgent={selectedAgent}
          onAgentSelect={setSelectedAgent}
        />

        <div className="flex-1 flex flex-col min-h-0">
          {/* Messages */}
          <div className="flex-1 overflow-y-auto px-4 py-4">
            {messages.length === 0 ? (
              <div className="text-center text-slate-500 mt-8">
                {selectedAgent
                  ? `${selectedAgent.name} 에이전트와 대화를 시작하세요.`
                  : '에이전트를 선택하고 대화를 시작하세요.'
                }
              </div>
            ) : (
              messages.map((message) => (
                <MessageBubble
                  key={message.id}
                  role={message.role}
                  content={message.content}
                  sources={message.sources}
                  error={message.error}
                />
              ))
            )}
            {isLoading && (
              <div className="flex justify-start mb-4">
                <div className="bg-slate-100 px-4 py-3 rounded-lg">
                  <div className="flex items-center space-x-2">
                    <div className="animate-spin rounded-full h-4 w-4 border-b-2 border-slate-600"></div>
                    <div className="text-sm text-slate-600">응답 생성 중...</div>
                  </div>
                </div>
              </div>
            )}
            <div ref={messagesEndRef} />
          </div>

          {/* Input */}
          <div className="border-t border-slate-200 px-4 py-4 bg-white">
            <div className="flex gap-2">
              <textarea
                value={inputMessage}
                onChange={(e) => setInputMessage(e.target.value)}
                onKeyPress={handleKeyPress}
                placeholder={selectedAgent ? "메시지를 입력하세요..." : "먼저 에이전트를 선택하세요"}
                disabled={!selectedAgent || isLoading}
                className="flex-1 px-3 py-2 border border-slate-300 rounded-md focus:outline-none focus:ring-2 focus:ring-slate-500 focus:border-slate-500 resize-none"
                rows={1}
              />
              <button
                onClick={handleSendMessage}
                disabled={!selectedAgent || !inputMessage.trim() || isLoading}
                className="px-4 py-2 bg-slate-900 text-white rounded-md hover:bg-slate-800 disabled:bg-slate-400 disabled:cursor-not-allowed flex items-center space-x-2"
              >
                {isLoading ? (
                  <div className="animate-spin rounded-full h-4 w-4 border-b-2 border-white"></div>
                ) : (
                  <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 19l9 2-9-18-9 18 9-2zm0 0v-8" />
                  </svg>
                )}
                <span>전송</span>
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}