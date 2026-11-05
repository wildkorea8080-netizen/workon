'use client';

import { useEffect, useRef, useState } from 'react';
import { locatePassage } from './source-locate';

/**
 * 원문에서 보기(2026-11-06) — 근거 문서의 원본을 글로 다시 읽어 보이고, 근거 발췌의 자리를 칠해 그곳으로 내린다.
 * 위치는 글자·숫자만 맞대 찾는다(`locatePassage`) — 못 찾으면 글만 보이고 그렇다고 알린다. 원본 서식(표 선·글꼴)은 보이지 않는다
 */
export default function SourceTextViewer({ href, title, passage, onClose }: { href: string; title: string; passage: string; onClose: () => void }) {
  const [state, setState] = useState<{ text: string; truncated: boolean } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const markRef = useRef<HTMLElement | null>(null);

  useEffect(() => {
    let live = true;
    void fetch(href)
      .then(async (res) => {
        const body = (await res.json().catch(() => null)) as { ok?: boolean; data?: { text: string; truncated: boolean }; error?: { message?: string } } | null;
        if (!live) return;
        if (res.ok && body?.ok && body.data) setState(body.data);
        else setError(body?.error?.message ?? '원문을 불러오지 못했습니다.');
      })
      .catch(() => live && setError('원문을 불러오지 못했습니다.'));
    return () => { live = false; };
  }, [href]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const found = state ? locatePassage(state.text, passage) : null;
  useEffect(() => { markRef.current?.scrollIntoView({ block: 'center' }); }, [found?.start, state]);

  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/30 px-4" onClick={onClose}>
      <div role="dialog" aria-modal="true" aria-label="원문에서 보기" className="flex h-[85vh] w-full max-w-3xl flex-col rounded-2xl bg-white shadow-2xl" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-start justify-between gap-3 border-b border-slate-100 px-5 py-3">
          <div className="min-w-0">
            <div className="text-sm font-bold text-slate-900">원문에서 보기</div>
            <div className="truncate text-xs text-slate-500" title={title}>{title}</div>
          </div>
          <button type="button" onClick={onClose} aria-label="원문 보기 닫기" className="h-8 w-8 flex-shrink-0 rounded-lg text-slate-400 hover:bg-slate-100 hover:text-slate-700">×</button>
        </div>
        <div className="flex-1 overflow-y-auto px-5 py-4">
          {error ? <p role="alert" className="text-sm text-red-600">{error}</p>
            : !state ? <p role="status" className="text-sm text-slate-500">원문을 읽는 중…</p>
            : (
              <>
                <p className={`mb-3 text-xs ${found ? 'text-slate-500' : 'text-amber-700'}`}>
                  {found ? '노란색이 AI가 본 근거의 자리입니다.' : '근거의 자리를 원문에서 찾지 못했습니다 — 글 전체를 보입니다.'}
                  {state.truncated ? ' 원문이 길어 앞부분만 보입니다.' : ''} 원본 서식(표 선·글꼴)은 보이지 않습니다.
                </p>
                <div className="whitespace-pre-wrap break-words text-sm leading-relaxed text-slate-800">
                  {found ? (
                    <>
                      {state.text.slice(0, found.start)}
                      <mark ref={markRef} className="rounded bg-yellow-200 px-0.5">{state.text.slice(found.start, found.end)}</mark>
                      {state.text.slice(found.end)}
                    </>
                  ) : state.text}
                </div>
              </>
            )}
        </div>
      </div>
    </div>
  );
}
