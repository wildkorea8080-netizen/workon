'use client';

import { useEffect, useState } from 'react';
import { useParams } from 'next/navigation';
import Link from 'next/link';

interface Message {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  created_at: string;
}

interface SharedConversation {
  id: string;
  title?: string;
  created_at: string;
  agent?: { id: string; name: string; description?: string } | null;
  messages: Message[];
}

function formatTime(d: string) {
  return new Date(d).toLocaleString('ko-KR', {
    month: 'short', day: 'numeric',
    hour: '2-digit', minute: '2-digit',
  });
}

export default function SharedConversationPage() {
  const { token } = useParams<{ token: string }>();
  const [data, setData] = useState<SharedConversation | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    fetch(`/api/shared/${token}`)
      .then(r => r.json())
      .then(result => {
        if (!result.ok) throw new Error(result.error?.message || '대화를 찾을 수 없습니다.');
        setData(result.data);
      })
      .catch(err => setError(err.message))
      .finally(() => setLoading(false));
  }, [token]);

  if (loading) {
    return (
      <div className="min-h-screen bg-[#F5F7FA] flex items-center justify-center">
        <div className="w-6 h-6 border-2 border-[#003087] border-t-transparent rounded-full animate-spin" />
      </div>
    );
  }

  if (error || !data) {
    return (
      <div className="min-h-screen bg-[#F5F7FA] flex flex-col items-center justify-center gap-4 text-center px-4">
        <div className="w-16 h-16 bg-red-100 rounded-full flex items-center justify-center">
          <svg className="w-8 h-8 text-red-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
          </svg>
        </div>
        <h1 className="text-lg font-semibold text-slate-800">대화를 찾을 수 없습니다</h1>
        <p className="text-slate-500 text-sm">{error || '공유가 취소됐거나 잘못된 링크입니다.'}</p>
        <Link href="/" className="text-[#003087] text-sm font-medium hover:underline">홈으로 이동</Link>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-[#F5F7FA]" style={{ fontFamily: 'Pretendard, -apple-system, sans-serif' }}>
      {/* 헤더 */}
      <header className="bg-[#1C2B4A] px-5 py-4 flex items-center justify-between">
        <div className="flex items-center gap-3">
          <span className="text-xl">🏛️</span>
          <div>
            <p className="text-white font-bold text-sm">AI 업무도우미</p>
            <p className="text-white/50 text-xs">공유된 대화</p>
          </div>
        </div>
        <Link
          href="/login"
          className="text-white/70 hover:text-white text-xs font-medium transition-colors"
        >
          로그인 →
        </Link>
      </header>

      {/* 대화 정보 */}
      <div className="max-w-2xl mx-auto px-4 py-8">
        <div className="bg-white rounded-2xl shadow-sm border border-slate-100 overflow-hidden">
          {/* 대화 메타 */}
          <div className="px-6 py-5 border-b border-slate-100">
            <div className="flex items-center gap-3 mb-1">
              <div className="w-8 h-8 rounded-lg bg-[#003087] flex items-center justify-center text-white text-sm font-bold flex-shrink-0">
                {data.agent?.name.slice(0, 1) ?? 'A'}
              </div>
              <div>
                <p className="text-sm font-bold text-slate-900">
                  {data.agent?.name ?? '알 수 없는 비서'}과의 대화
                </p>
                <p className="text-xs text-slate-400">{formatTime(data.created_at)}</p>
              </div>
            </div>
            {data.title && (
              <h1 className="text-base font-semibold text-slate-800 mt-3">{data.title}</h1>
            )}
          </div>

          {/* 메시지 목록 */}
          <div className="px-6 py-5 space-y-5">
            {data.messages.map(msg => (
              <div
                key={msg.id}
                className={`flex gap-3 ${msg.role === 'user' ? 'flex-row-reverse' : 'flex-row'}`}
              >
                {msg.role === 'assistant' && (
                  <div className="w-7 h-7 rounded-lg bg-[#1C2B4A] flex items-center justify-center text-white text-xs font-bold flex-shrink-0 mt-0.5">
                    {data.agent?.name.slice(0, 1) ?? 'A'}
                  </div>
                )}
                <div
                  className={`max-w-[80%] px-4 py-3 rounded-2xl text-sm leading-relaxed whitespace-pre-wrap ${
                    msg.role === 'user'
                      ? 'bg-[#003087] text-white rounded-tr-sm'
                      : 'bg-slate-100 text-slate-800 rounded-tl-sm'
                  }`}
                >
                  {msg.content}
                </div>
              </div>
            ))}
          </div>
        </div>

        <p className="text-center text-xs text-slate-400 mt-6">
          이 대화는 AI 업무도우미에서 생성됐습니다.{' '}
          <Link href="/login" className="text-[#003087] hover:underline">서비스 이용하기</Link>
        </p>
      </div>
    </div>
  );
}
