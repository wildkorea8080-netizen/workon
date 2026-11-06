'use client';

import { useState } from 'react';
import { FEEDBACK_REASONS, type FeedbackReason, type MessageFeedback } from '@/lib/message-feedback-spec';

/**
 * 답변 평가(2026-11-05, 0064) — '도움됨 / 아쉬움', 아쉬우면 정해 둔 이유 하나. 다시 누르면 지운다.
 * 관리자는 비서별 숫자만 본다(질문·답변·누가 남겼는지는 보지 않는다)
 */
export default function AnswerFeedback({ messageId, initial }: { messageId: string; initial: MessageFeedback | null }) {
  const [feedback, setFeedback] = useState<MessageFeedback | null>(initial);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function save(next: MessageFeedback | null) {
    const before = feedback;
    setFeedback(next);
    setSaving(true);
    setError(null);
    try {
      const res = await fetch(`/api/messages/${encodeURIComponent(messageId)}/feedback`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(next ? { rating: next.rating, reason: next.reason } : { rating: null }),
      });
      const body = (await res.json().catch(() => null)) as { ok?: boolean; error?: { message?: string } } | null;
      if (!res.ok || !body?.ok) throw new Error(body?.error?.message ?? '평가를 저장하지 못했습니다.');
    } catch (e) {
      setFeedback(before);
      setError(e instanceof Error ? e.message : '평가를 저장하지 못했습니다.');
    } finally {
      setSaving(false);
    }
  }

  const base = 'rounded-md border px-2 py-0.5 text-[11px] disabled:opacity-50';
  const on = 'border-[#087f8c] bg-[#087f8c]/5 text-[#087f8c] font-semibold';
  const off = 'border-slate-200 text-slate-500 hover:text-slate-800';
  return (
    <div className="mt-1.5 flex flex-wrap items-center gap-1.5" aria-label="답변 평가">
      <button type="button" disabled={saving} aria-pressed={feedback?.rating === 'up'} className={`${base} ${feedback?.rating === 'up' ? on : off}`} onClick={() => void save(feedback?.rating === 'up' ? null : { rating: 'up', reason: null })}>도움됨</button>
      <button type="button" disabled={saving} aria-pressed={feedback?.rating === 'down'} className={`${base} ${feedback?.rating === 'down' ? on : off}`} onClick={() => void save(feedback?.rating === 'down' ? null : { rating: 'down', reason: null })}>아쉬움</button>
      {feedback?.rating === 'down' && (Object.keys(FEEDBACK_REASONS) as FeedbackReason[]).map((reason) => (
        <button key={reason} type="button" disabled={saving} aria-pressed={feedback.reason === reason} className={`${base} ${feedback.reason === reason ? on : off}`} onClick={() => void save({ rating: 'down', reason: feedback.reason === reason ? null : reason })}>
          {FEEDBACK_REASONS[reason]}
        </button>
      ))}
      {error && <span role="alert" className="text-[11px] text-red-600">{error}</span>}
    </div>
  );
}
