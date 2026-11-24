'use client';

import { useState } from 'react';
import AppResultExport from '@/components/apps/AppResultExport';
import type { RevisionView } from '@/lib/assistant/answer-revise-spec';

/** 대화 답변 내보내기의 안내·단추 글 — 시험이 같은 글을 본다 */
export const ANSWER_EXPORT_BUTTON = '한글 파일로 받기';
export const ANSWER_EXPORT_INTRO = '저장된 답변을 그대로 한글(HWPX) 파일에 담습니다(AI를 다시 부르지 않음). 질문·비서 이름·참고한 출처가 함께 들어가고, AI 작성 초안이라는 안내가 붙습니다.';

/**
 * 일반 대화 답변을 한글 파일로 받기(2026-11-23). 예전엔 입력형 앱 결과만 받을 수 있어, 직원이 답변을 복사해 한글에 붙여 넣었다.
 * 답변마다 큰 칸을 두면 대화가 어지러워 작은 단추로 두고, 누르면 앱 결과와 같은 칸(표준 보고서·비서의 기관 양식)을 연다.
 * 근거로 고쳐 쓴 답이 있으면 담을 답을 고른다(기본은 고쳐 쓴 답).
 */
export default function AnswerExport({ conversationId, messageId, content, revision }: {
  conversationId: string;
  messageId: string;
  content: string;
  revision: RevisionView | null;
}) {
  const [open, setOpen] = useState(false);
  const [which, setWhich] = useState<'revised' | 'original'>('revised');
  const useRevised = Boolean(revision) && which === 'revised';

  if (!open) {
    return (
      <div className="ml-10 mt-1">
        <button type="button" onClick={() => setOpen(true)} className="text-[11px] text-slate-500 underline-offset-2 hover:text-ws-accent-text hover:underline">
          {ANSWER_EXPORT_BUTTON}
        </button>
      </div>
    );
  }

  return (
    <div className="ml-10">
      {revision && (
        <label className="mt-2 block text-xs text-slate-600">
          담을 답
          <select aria-label="담을 답" value={which} onChange={(e) => setWhich(e.target.value === 'original' ? 'original' : 'revised')} className="ml-2 rounded-lg border border-slate-200 bg-white px-2 py-1 text-xs">
            <option value="revised">근거로 고쳐 쓴 답</option>
            <option value="original">원래 답변</option>
          </select>
        </label>
      )}
      <AppResultExport
        key={useRevised ? 'revised' : 'original'}
        conversationId={conversationId}
        messageId={messageId}
        content={useRevised && revision ? revision.text : content}
        variant={useRevised ? 'revised' : undefined}
        intro={ANSWER_EXPORT_INTRO}
      />
    </div>
  );
}
