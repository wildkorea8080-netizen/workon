'use client';

import { useState } from 'react';
import MessageBubble from './MessageBubble';
import type { RetrievedChunk } from '@/lib/db';
import { REVISE_BUTTON_HINT, REVISE_BUTTON_LABEL, REVISION_LABEL, readRevision, type RevisionView } from '@/lib/assistant/answer-revise-spec';

/** 고쳐 쓴 답 위에 붙는 안내 — 무엇을 다시 확인했는지 */
export function revisionNote(revision: RevisionView): string {
  return revision.revisedNumbers.length
    ? `원래 답변의 확인되지 않은 숫자(${revision.revisedNumbers.join(' · ')})를 문서에서 다시 찾아 고쳐 썼습니다. 원래 답변은 위에 그대로 있습니다.`
    : '문서에서 다시 찾아 고쳐 썼습니다. 원래 답변은 위에 그대로 있습니다.';
}

/**
 * 근거로 고쳐 쓰기(2026-11-08) — 확인되지 않은 숫자가 남은 문서 근거 답변 아래 단추. 누르면 서버가 다시 찾은 근거로 한 번 고쳐 쓰고,
 * 고쳐 쓴 답을 원래 답변 아래 따로 보인다(원래 답변은 그대로). 이미 고쳐 쓴 답은 단추 대신 그 답을 보인다
 */
export default function AnswerRevision({
  messageId, initial, eligible, onOpenSource, onRevised,
}: {
  messageId: string;
  initial: RevisionView | null;
  eligible: boolean;
  onOpenSource?: (source: RetrievedChunk) => void;
  /** 고쳐 쓴 답을 대화 화면 상태에도 남긴다 — 다음 질문으로 다시 그려도 단추로 돌아가지 않게 */
  onRevised?: (revision: RevisionView) => void;
}) {
  const [revision, setRevision] = useState<RevisionView | null>(initial);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [unsaved, setUnsaved] = useState(false);

  async function revise() {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/messages/${encodeURIComponent(messageId)}/revise`, { method: 'POST' });
      const body = (await res.json().catch(() => null)) as { ok?: boolean; data?: { revision?: unknown; saved?: boolean }; error?: { message?: string } } | null;
      const next = body?.ok ? readRevision(body.data?.revision) : null;
      if (!res.ok || !next) throw new Error(body?.error?.message ?? '고쳐 쓰지 못했습니다.');
      setRevision(next);
      onRevised?.(next);
      setUnsaved(body?.data?.saved === false);
    } catch (e) {
      setError(e instanceof Error ? e.message : '고쳐 쓰지 못했습니다.');
    } finally {
      setBusy(false);
    }
  }

  if (revision) {
    return (
      <div className="mt-2" aria-label={REVISION_LABEL}>
        <p className="mb-1 ml-10 text-[11px] text-slate-500">{revisionNote(revision)}{unsaved ? ' 저장하지 못해 새로 열면 보이지 않습니다.' : ''}</p>
        <MessageBubble role="assistant" content={revision.text} sources={revision.chunks} numberCheck={revision.unverified} badge={REVISION_LABEL} onOpenSource={onOpenSource} />
      </div>
    );
  }
  if (!eligible) return null;
  return (
    <div className="mt-1.5 flex flex-wrap items-center gap-2">
      <button
        type="button"
        disabled={busy}
        title={REVISE_BUTTON_HINT}
        onClick={() => void revise()}
        className="rounded-md border border-amber-300 bg-amber-50 px-2 py-0.5 text-[11px] font-semibold text-amber-800 hover:bg-amber-100 disabled:opacity-50"
      >
        {busy ? '문서를 다시 찾아 고쳐 쓰는 중…' : REVISE_BUTTON_LABEL}
      </button>
      {error && <span role="alert" className="text-[11px] text-red-600">{error}</span>}
    </div>
  );
}
