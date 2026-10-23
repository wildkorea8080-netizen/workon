'use client';

import { useEffect } from 'react';
import type { RetrievedChunk } from '@/lib/db';
import { sourceLocationLabel, stripNodaPrefixes, sourceNumber } from './source-label';

interface SourcePanelProps {
  /** 연 근거. null이면 닫혀 있다 */
  source: RetrievedChunk | null;
  onClose: () => void;
}

/**
 * 답변 근거 문서 — 오른쪽에서 미끄러져 나오는 창(2026-10-23).
 * 출처 칩이나 답변 속 `[n]`을 누르면 그 근거의 문서 이름·쪽·절·원문을 보인다.
 * × · 바깥 누르기 · Esc로 닫는다. 원문은 NODA 근거 묶음의 그 번호 글이다(옛 메시지는 원문이 없다).
 */
export default function SourcePanel({ source, onClose }: SourcePanelProps) {
  const open = source !== null;

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  const title = source ? (source.documentTitle && stripNodaPrefixes(source.documentTitle)) || '제목 없는 문서' : '';
  const text = source?.text?.trim() ?? '';

  return (
    <>
      {/* 바깥 — 누르면 닫힌다 */}
      <div
        aria-hidden="true"
        onClick={onClose}
        className={`fixed inset-0 z-40 bg-black/10 transition-opacity duration-200 ${open ? 'opacity-100' : 'opacity-0 pointer-events-none'}`}
      />
      <aside
        role="dialog"
        aria-modal="true"
        aria-label="답변 근거 문서"
        aria-hidden={!open}
        className={`fixed top-0 right-0 z-50 h-full w-full sm:w-[440px] bg-white shadow-2xl border-l border-slate-200 flex flex-col transition-transform duration-200 ease-out ${open ? 'translate-x-0' : 'translate-x-full'}`}
      >
        {source && (
          <>
            <div className="flex items-start justify-between gap-3 px-5 py-4 border-b border-slate-100">
              <div className="min-w-0 border-l-4 border-[#003087] pl-3">
                <div className="text-sm font-bold text-slate-900">답변 근거 문서</div>
                <div className="text-xs text-slate-500 mt-0.5 truncate" title={title}>
                  [{sourceNumber(source)}] {title}
                </div>
              </div>
              <button
                type="button"
                onClick={onClose}
                aria-label="근거 창 닫기"
                className="flex-shrink-0 w-8 h-8 inline-flex items-center justify-center rounded-lg text-slate-400 hover:text-slate-700 hover:bg-slate-100"
              >
                <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                </svg>
              </button>
            </div>

            <div className="flex-1 overflow-y-auto px-5 py-4">
              <div className="flex items-center flex-wrap gap-1.5 text-xs text-slate-500 mb-3">
                <span>{sourceLocationLabel(source)}</span>
                {source.ocr && (
                  <span
                    title="원문을 글자 인식으로 읽어 숫자·글자가 다를 수 있습니다"
                    className="inline-block bg-amber-50 border border-amber-200 text-amber-800 rounded px-1.5 py-px text-[10px] font-medium"
                  >
                    스캔 판독
                  </span>
                )}
              </div>
              {text ? (
                <div className="text-sm leading-relaxed text-slate-800 whitespace-pre-wrap break-words">{text}</div>
              ) : (
                <p className="text-sm text-slate-500">
                  이 답변에는 근거 원문이 저장돼 있지 않습니다(이전에 받은 답변). 문서 이름과 위치로 원문을 확인해 주세요.
                </p>
              )}
            </div>

            <div className="px-5 py-3 border-t border-slate-100 text-[11px] text-slate-400">
              AI가 이 근거를 보고 답했습니다. 중요한 내용은 원문 문서에서 다시 확인하세요.
            </div>
          </>
        )}
      </aside>
    </>
  );
}
