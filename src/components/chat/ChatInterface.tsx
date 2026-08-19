'use client';

import { useState, useRef, useEffect } from 'react';
import { useBranding } from '@/lib/use-branding';
import MessageBubble from './MessageBubble';
import type { Agent, RetrievedChunk } from '@/lib/db';
import {
  MAX_CHAT_IMAGES,
  IMAGE_ACCEPT_ATTRIBUTE,
  validateChatImages,
  type ChatImage,
} from '@/lib/chat-images';
import { fileToChatImage } from '@/lib/image-resize';
import { connectorShortLabel } from '@/lib/connector-labels';

interface ToolLink {
  title: string;
  url: string;
}

interface Message {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  /** 사용자가 이 메시지에 붙인 이미지 미리보기 (blob URL) */
  imagePreviews?: string[];
  sources?: RetrievedChunk[];
  /** 외부 도구가 돌려준 출처 링크 */
  links?: ToolLink[];
  error?: string;
}

/** 도구 이름 → 사용자에게 보일 문구 */
const TOOL_LABELS: Record<string, string> = {
  law_search: '국가법령정보에서 법령을 찾는 중',
  law_get_articles: '법령 조문을 읽는 중',
};

function toolLabel(name: string) {
  return TOOL_LABELS[name] ?? `${name} 실행 중`;
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

type ModelOption = {
  id: string;
  label: string;
  note: string;
  inputPerMTok: number;
  outputPerMTok: number;
};

export default function ChatInterface({
  selectedAgent,
  conversationId,
  onConversationCreated,
  onChangeAgent,
}: ChatInterfaceProps) {
  const branding = useBranding();
  // 기관이 허용한 모델(0021). 하나뿐이면 고를 것이 없으므로 화면에 내지 않는다.
  const [models, setModels] = useState<ModelOption[]>([]);
  const [selectedModel, setSelectedModel] = useState<string | null>(null);
  const [messages, setMessages] = useState<Message[]>([]);
  const [inputMessage, setInputMessage] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const [loadingConv, setLoadingConv] = useState(false);
  // 현재 실행 중인 도구 이름 (없으면 null)
  const [activeTool, setActiveTool] = useState<string | null>(null);
  // 보내기 전에 붙여 둔 이미지. 전송 후 비운다.
  const [pendingImages, setPendingImages] = useState<{ image: ChatImage; preview: string }[]>([]);
  const [imageError, setImageError] = useState<string | null>(null);
  const [preparingImages, setPreparingImages] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const prevConvIdRef = useRef<string | null>(null);

  useEffect(() => {
    fetch('/api/models')
      .then((r) => r.json())
      .then((r) => {
        if (!r.ok) return;
        const list: ModelOption[] = r.data ?? [];
        setModels(list);
        // 기본값은 목록의 첫 번째. 서버가 정책 순서대로 준다.
        setSelectedModel((prev) => prev ?? list[0]?.id ?? null);
      })
      .catch(() => {});
  }, []);

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
        // 출처는 source_references(JSONB)에 들어 있다.
        // 예전에는 m.sources를 읽어 항상 undefined였고, 대화를 다시 열면
        // 출처가 사라졌다.
        setMessages(
          (result.data.messages ?? []).map(
            (m: {
              id: string;
              role: 'user' | 'assistant';
              content: string;
              source_references?: { chunks?: RetrievedChunk[]; links?: ToolLink[] };
            }) => ({
              id: m.id,
              role: m.role,
              content: m.content,
              sources: m.source_references?.chunks,
              links: m.source_references?.links,
            })
          )
        );
      })
      .catch(() => {})
      .finally(() => setLoadingConv(false));
  }, [conversationId]);

  // 에이전트가 바뀌면 메시지 초기화
  useEffect(() => {
    if (!conversationId) setMessages([]);
  }, [selectedAgent.id, conversationId]);

  const addFiles = async (files: FileList | File[]) => {
    setImageError(null);
    const picked = Array.from(files);
    if (picked.length === 0) return;

    const room = MAX_CHAT_IMAGES - pendingImages.length;
    if (room <= 0) {
      setImageError(`이미지는 ${MAX_CHAT_IMAGES}장까지 첨부할 수 있습니다.`);
      return;
    }

    setPreparingImages(true);
    try {
      const added: { image: ChatImage; preview: string }[] = [];
      for (const file of picked.slice(0, room)) {
        try {
          // 브라우저에서 줄여 보낸다. 요청 본문 상한과 토큰이 함께 줄어든다.
          added.push({ image: await fileToChatImage(file), preview: URL.createObjectURL(file) });
        } catch (err) {
          setImageError(err instanceof Error ? err.message : '이미지를 처리하지 못했습니다.');
        }
      }
      if (added.length > 0) setPendingImages(prev => [...prev, ...added]);
      if (picked.length > room) {
        setImageError(`이미지는 ${MAX_CHAT_IMAGES}장까지 첨부할 수 있습니다.`);
      }
    } finally {
      setPreparingImages(false);
    }
  };

  const removeImage = (index: number) => {
    setImageError(null);
    setPendingImages(prev => {
      // blob URL을 놓아주지 않으면 대화가 길어질수록 메모리가 는다
      URL.revokeObjectURL(prev[index]?.preview ?? '');
      return prev.filter((_, i) => i !== index);
    });
  };

  const handleSendMessage = async () => {
    if ((!inputMessage.trim() && pendingImages.length === 0) || isLoading) return;
    if (preparingImages) return;

    // 화면 검사는 편의일 뿐이고 서버가 다시 본다. 다만 여기서 걸러야
    // 사용자가 보낸 뒤에야 거절당하는 일이 없다.
    const images = pendingImages.map(p => p.image);
    const localError = validateChatImages(images);
    if (localError) {
      setImageError(localError);
      return;
    }

    const userMsg: Message = {
      id: Date.now().toString(),
      role: 'user',
      content: inputMessage.trim(),
      imagePreviews: pendingImages.map(p => p.preview),
    };
    const assistantId = String(Date.now() + 1);

    setMessages(prev => [...prev, userMsg]);
    setInputMessage('');
    // 미리보기 URL은 말풍선이 계속 쓰므로 여기서 revoke 하지 않는다
    setPendingImages([]);
    setImageError(null);
    setIsLoading(true);
    setActiveTool(null);

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
          message: userMsg.content || '이 이미지를 설명해주세요.',
          conversation_id: conversationId,
          images: images.length > 0 ? images : undefined,
          // 허용되지 않은 값이면 서버가 정책에 맞는 모델로 바꿔 처리한다
          model: selectedModel ?? undefined,
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
      const collectedLinks: ToolLink[] = [];
      let bubbleShown = false;

      // 첫 텍스트가 도착하는 순간 말풍선을 만든다.
      // 그 전까지는 로딩 인디케이터가 계속 보인다.
      const showBubble = () => {
        bubbleShown = true;
        setIsLoading(false);
        setMessages(prev => [
          ...prev,
          {
            id: assistantId,
            role: 'assistant',
            content: streamed,
            sources: pendingSources,
            links: collectedLinks.length ? [...collectedLinks] : undefined,
          },
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
          } else if (name === 'tool_start') {
            setActiveTool(payload.name);
          } else if (name === 'tool_end') {
            setActiveTool(null);
            for (const source of payload.sources ?? []) {
              if (!collectedLinks.some((l) => l.url === source.url)) collectedLinks.push(source);
            }
            if (bubbleShown && collectedLinks.length) {
              patchAssistant({ links: [...collectedLinks] });
            }
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
      setActiveTool(null);
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSendMessage();
    }
  };

  const bg = pickBg(selectedAgent.name);
  // 이 비서가 쓸 수 있는 외부 도구. 이름은 connector-labels.ts 한 곳에서 온다.
  const connectorNames = (selectedAgent.enabled_connectors ?? []).map(connectorShortLabel);

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

      {/* 민감정보 안내.
          공공기관은 주민등록번호·연락처가 담긴 공문과 명단을 상시 다룬다.
          하단 AI 고지와 별개로, 무엇을 넣기 **전에** 보여야 뜻이 있다. */}
      <div className="px-5 pt-3 bg-[#F5F7FA] flex-shrink-0">
        <div className="flex items-start gap-2 bg-[#003087]/5 border border-[#003087]/10 rounded-xl px-3.5 py-2.5">
          <svg className="w-4 h-4 text-[#003087] flex-shrink-0 mt-px" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01M5 19h14a2 2 0 001.84-2.75L13.74 4a2 2 0 00-3.48 0l-7.1 12.25A2 2 0 004.99 19z" />
          </svg>
          <p className="text-xs text-slate-600 leading-relaxed">
            <span className="font-semibold text-slate-800">{selectedAgent.name}</span>와(과) 일합니다.
            주민등록번호·연락처 등 개인정보는 지우고 입력·업로드해주세요.
          </p>
        </div>
      </div>

      {/* 메시지 영역 */}
      <div className="flex-1 overflow-y-auto px-5 pt-3 pb-5 space-y-1 bg-[#F5F7FA]">
        {loadingConv ? (
          <div className="flex items-center justify-center h-full">
            <div className="w-5 h-5 border-2 border-brand-400 border-t-transparent rounded-full animate-spin" />
          </div>
        ) : messages.length === 0 ? (
          // 아이콘과 이름만 띄우면 무엇을 넣어야 하는지 알 수 없다.
          // 비서마다 필요한 입력이 달라(공문은 내용, 회의록은 녹취) 여기서 알린다.
          <div className="flex flex-col items-center justify-center h-full pb-10">
            <div className="w-full max-w-xl">
              <div className="flex flex-col items-center text-center gap-3">
                <div className={`w-14 h-14 rounded-2xl ${bg} flex items-center justify-center text-white text-2xl font-bold shadow-lg`}>
                  {selectedAgent.icon ?? selectedAgent.name.slice(0, 1)}
                </div>
                <p className="text-base font-semibold text-slate-800">{selectedAgent.name}</p>
              </div>

              <div className="mt-4 bg-white border border-slate-200 rounded-2xl px-5 py-4 text-sm text-slate-600 leading-relaxed">
                {selectedAgent.description || '무엇이든 질문해보세요.'}
                {connectorNames.length > 0 && (
                  <p className="mt-2.5 text-slate-500">
                    필요하면 <span className="font-semibold text-slate-700">{connectorNames.join(' · ')}</span>
                    에서 자료를 찾아 근거와 함께 답합니다.
                  </p>
                )}
              </div>
            </div>
          </div>
        ) : (
          messages.map(msg => (
            <MessageBubble
              key={msg.id}
              role={msg.role}
              content={msg.content}
              imagePreviews={msg.imagePreviews}
              sources={msg.sources}
              links={msg.links}
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
                <div className="flex gap-2 items-center">
                  <div className="flex gap-1.5 items-center">
                    <span className="w-1.5 h-1.5 bg-slate-400 rounded-full animate-bounce" style={{ animationDelay: '0ms' }} />
                    <span className="w-1.5 h-1.5 bg-slate-400 rounded-full animate-bounce" style={{ animationDelay: '150ms' }} />
                    <span className="w-1.5 h-1.5 bg-slate-400 rounded-full animate-bounce" style={{ animationDelay: '300ms' }} />
                  </div>
                  {activeTool && (
                    <span className="text-xs text-slate-500">{toolLabel(activeTool)}...</span>
                  )}
                </div>
              </div>
            </div>
          </div>
        )}
        <div ref={messagesEndRef} />
      </div>

      {/* 입력 영역 */}
      <div className="px-5 py-4 bg-white border-t border-slate-100 flex-shrink-0">
        {/* 대화가 이어진 뒤에만 알린다. 첫 화면에서는 잔소리가 된다. */}
        {messages.length > 0 && (
          <div className="mb-2.5 flex flex-wrap items-center gap-2">
            <button
              type="button"
              onClick={onChangeAgent}
              className="text-xs font-semibold text-[#003087] border border-[#003087]/20 hover:bg-[#003087]/5 rounded-lg px-2.5 py-1.5 transition-colors"
            >
              다른 비서와 새 대화
            </button>
            <span className="text-[11px] text-slate-400 leading-relaxed">
              앞 질문과 이어지지 않는 내용은 새 대화로 물어야 정확합니다.
            </span>
          </div>
        )}

        {imageError && (
          <p className="mb-2 text-xs text-red-600">{imageError}</p>
        )}

        {pendingImages.length > 0 && (
          <div className="mb-2 flex flex-wrap gap-2">
            {pendingImages.map((item, index) => (
              <div key={item.preview} className="relative group">
                {/* next/image는 blob URL을 다루지 않는다 */}
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img
                  src={item.preview}
                  alt={`첨부 이미지 ${index + 1}`}
                  className="w-16 h-16 object-cover rounded-lg border border-slate-200"
                />
                <button
                  type="button"
                  onClick={() => removeImage(index)}
                  aria-label={`첨부 이미지 ${index + 1} 제거`}
                  className="absolute -top-1.5 -right-1.5 w-5 h-5 rounded-full bg-slate-700 text-white text-xs flex items-center justify-center hover:bg-slate-900"
                >
                  ×
                </button>
              </div>
            ))}
            {/* 다음 턴에 왜 "아까 그 사진"이 안 되는지 미리 알린다 */}
            <p className="w-full text-[11px] text-slate-400">
              이미지는 이번 질문에만 전달됩니다. 다음 질문에서 다시 보려면 새로 첨부하세요.
            </p>
          </div>
        )}

        <input
          ref={fileInputRef}
          type="file"
          accept={IMAGE_ACCEPT_ATTRIBUTE}
          multiple
          className="hidden"
          onChange={e => {
            if (e.target.files) addFiles(e.target.files);
            // 같은 파일을 다시 고를 수 있게 비운다
            e.target.value = '';
          }}
        />

        <div className="flex items-end gap-3 bg-slate-50 border border-slate-200 rounded-2xl px-4 py-3 focus-within:border-[#003087] focus-within:ring-2 focus-within:ring-[#003087]/10 transition-all">
          <button
            type="button"
            onClick={() => fileInputRef.current?.click()}
            disabled={isLoading || preparingImages || pendingImages.length >= MAX_CHAT_IMAGES}
            aria-label="이미지 첨부"
            title={`이미지 첨부 (최대 ${MAX_CHAT_IMAGES}장)`}
            className="flex-shrink-0 w-8 h-8 rounded-lg text-slate-500 hover:text-[#003087] hover:bg-white disabled:text-slate-300 disabled:hover:bg-transparent disabled:cursor-not-allowed flex items-center justify-center transition-colors"
          >
            {preparingImages ? (
              <svg className="w-4 h-4 animate-spin" fill="none" viewBox="0 0 24 24">
                <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v8H4z" />
              </svg>
            ) : (
              <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 16l4.586-4.586a2 2 0 012.828 0L16 16m-2-2l1.586-1.586a2 2 0 012.828 0L20 14m-6-6h.01M6 20h12a2 2 0 002-2V6a2 2 0 00-2-2H6a2 2 0 00-2 2v12a2 2 0 002 2z" />
              </svg>
            )}
          </button>
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
            disabled={(!inputMessage.trim() && pendingImages.length === 0) || isLoading || preparingImages}
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
        <div className="flex items-center justify-center gap-3 mt-2 flex-wrap">
          {/* 모델 선택 — 기관이 허용한 것이 둘 이상일 때만 낸다.
              하나뿐인데 드롭다운을 보여주면 고를 수 있다는 오해만 준다. */}
          {models.length > 1 && (
            <label className="flex items-center gap-1.5 text-xs text-slate-400">
              <span>모델</span>
              <select
                value={selectedModel ?? ''}
                onChange={(e) => setSelectedModel(e.target.value)}
                title={models.find((m) => m.id === selectedModel)?.note}
                className="px-2 py-1 border border-slate-200 rounded-lg bg-white text-slate-600 text-xs focus:outline-none focus:ring-2 focus:ring-[#003087]/20"
              >
                {models.map((m) => (
                  <option key={m.id} value={m.id} title={m.note}>
                    {m.label}
                  </option>
                ))}
              </select>
            </label>
          )}
          <p className="text-xs text-slate-400">Enter로 전송 · Shift+Enter로 줄바꿈</p>
        </div>
        {/* AI 고지. senGPT도 명시하고 있고 공공기관 배포에서는 사실상 필수다.
            생성 결과를 그대로 결재에 올리면 안 된다는 것을 화면이 계속 알려야 한다. */}
        <p className="text-[11px] text-slate-400 mt-1 text-center px-4">{branding.aiNotice}</p>
      </div>
    </div>
  );
}
