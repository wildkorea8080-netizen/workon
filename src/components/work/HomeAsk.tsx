'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import WorkspaceIcon from './WorkspaceIcon';
import { CHAT_HANDOFF_MAX_CHARS, stashQuestion } from '@/lib/chat-handoff';
import { isImeComposing } from '@/lib/ime';

/**
 * 업무 홈의 '바로 묻기'(2026-11-06) — 앱을 고르지 않고 홈에서 바로 물으면 AI 대화가 시작된다(웍스AI·알리웍스 홈과 같은 길).
 * 답할 비서는 AI 대화 첫 화면과 같은 규칙(이번에 쓴 비서 → 마지막 대화의 비서 → 첫 공식 비서)으로 대화 화면이 고른다.
 * 질문은 주소가 아니라 이 탭의 저장소로 넘긴다(`chat-handoff.ts`).
 */
export default function HomeAsk() {
  const router = useRouter();
  const [text, setText] = useState('');
  const [error, setError] = useState<string | null>(null);
  const tooLong = text.trim().length > CHAT_HANDOFF_MAX_CHARS;

  function send() {
    const question = text.trim();
    if (!question) return;
    if (tooLong) {
      setError(`질문이 너무 깁니다(${CHAT_HANDOFF_MAX_CHARS.toLocaleString()}자까지). 긴 자료는 AI 대화에서 파일로 붙여 주세요.`);
      return;
    }
    if (!stashQuestion(question)) {
      setError('이 브라우저에서는 질문을 넘기지 못했습니다. AI 대화에서 다시 적어 주세요.');
      return;
    }
    router.push('/chat');
  }

  return (
    <section aria-label="바로 묻기" className="mb-8">
      <form
        onSubmit={(e) => {
          e.preventDefault();
          send();
        }}
        className="workspace-card flex items-end gap-3 rounded-2xl border border-[#E7E9F1] bg-white px-5 py-4 transition-all focus-within:border-ws-accent-text focus-within:ring-2 focus-within:ring-ws-accent-text/15"
      >
        <WorkspaceIcon name="chat" className="mb-1 flex-shrink-0 text-ws-accent-text" />
        <textarea
          value={text}
          onChange={(e) => {
            setText(e.target.value);
            setError(null);
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey && !isImeComposing(e)) {
              e.preventDefault();
              send();
            }
          }}
          aria-label="AI에게 바로 묻기"
          placeholder="궁금한 것을 바로 물어보세요 — 예: 국외 출장 여비 기준이 어떻게 되나요?"
          rows={1}
          className="min-h-[24px] max-h-[120px] flex-1 resize-none border-0 bg-transparent text-[15px] leading-relaxed text-slate-900 placeholder-slate-400 focus:outline-none"
        />
        <button
          type="submit"
          disabled={!text.trim()}
          aria-label="묻기"
          className="flex h-9 w-9 flex-shrink-0 items-center justify-center rounded-xl bg-ws-accent text-white transition-colors hover:bg-ws-accent-hover disabled:cursor-not-allowed disabled:bg-slate-200"
        >
          <WorkspaceIcon name="arrow" className="!h-4 !w-4" />
        </button>
      </form>
      {error ? (
        <p role="alert" className="mt-2 text-xs text-red-600">{error}</p>
      ) : (
        <p className="mt-2 text-xs text-slate-500">
          AI 대화에서 답합니다 — 답할 비서는 대화 화면에 표시되고 바꿀 수 있습니다. 주민등록번호·휴대전화 번호 같은 개인정보는 적지 마세요.
        </p>
      )}
    </section>
  );
}
