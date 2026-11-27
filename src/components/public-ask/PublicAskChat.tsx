'use client';

import { useRef, useState } from 'react';
import { isImeComposing } from '@/lib/ime';
import { PUBLIC_ASK_MESSAGES, PUBLIC_ASK_QUESTION_MAX, type PublicAskConfig, type PublicAskContact } from '@/lib/public-ask/spec';

type Turn = { question: string; answer: string; state: 'streaming' | 'done' | 'error'; found?: boolean; sources?: string[]; unverified?: string[]; error?: string };

/**
 * 시민용 민원 상담 창의 화면(2026-11-27, 0136). 대화는 이 화면에만 있고 서버에 이어 두지 않는다 —
 * 이어 묻기에는 바로 앞 질문 하나만 보내 '앞 질문과 묶어 다시 찾기'에 쓴다
 */
export default function PublicAskChat({ slug, config, embed }: { slug: string; config: PublicAskConfig; embed: boolean }) {
  const [turns, setTurns] = useState<Turn[]>([]);
  const [draft, setDraft] = useState('');
  const [busy, setBusy] = useState(false);
  const bottom = useRef<HTMLDivElement>(null);

  async function send(text: string) {
    const question = text.trim();
    if (!question || busy) return;
    if (question.length > PUBLIC_ASK_QUESTION_MAX) { setTurns((t) => [...t, { question: question.slice(0, 80) + '…', answer: '', state: 'error', error: PUBLIC_ASK_MESSAGES.badQuestion }]); return; }
    const previousQuestion = turns.length ? turns[turns.length - 1].question : undefined;
    setBusy(true);
    setDraft('');
    setTurns((t) => [...t, { question, answer: '', state: 'streaming' }]);
    const update = (patch: Partial<Turn> | ((t: Turn) => Partial<Turn>)) =>
      setTurns((all) => all.map((t, i) => (i === all.length - 1 ? { ...t, ...(typeof patch === 'function' ? patch(t) : patch) } : t)));
    try {
      const res = await fetch(`/api/ask/${encodeURIComponent(slug)}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ question, previousQuestion }) });
      if (!res.ok || !res.body || !(res.headers.get('content-type') ?? '').includes('text/event-stream')) {
        const body = await res.json().catch(() => null) as { error?: { message?: string } } | null;
        update({ state: 'error', error: body?.error?.message || PUBLIC_ASK_MESSAGES.unavailable });
        return;
      }
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buf = '';
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        let cut: number;
        while ((cut = buf.indexOf('\n\n')) >= 0) {
          const line = buf.slice(0, cut).replace(/^data: /, '');
          buf = buf.slice(cut + 2);
          let ev: { type?: string; text?: string; found?: boolean; sources?: string[]; unverified?: string[]; message?: string };
          try { ev = JSON.parse(line); } catch { continue; }
          if (ev.type === 'delta' && ev.text) update((t) => ({ answer: t.answer + ev.text }));
          else if (ev.type === 'done') update({ state: 'done', found: ev.found, sources: ev.sources ?? [], unverified: ev.unverified ?? [] });
          else if (ev.type === 'error') update({ state: 'error', error: ev.message || PUBLIC_ASK_MESSAGES.unavailable });
        }
      }
      update((t) => (t.state === 'streaming' ? { state: 'error', error: PUBLIC_ASK_MESSAGES.unavailable } : {}));
    } catch {
      update({ state: 'error', error: PUBLIC_ASK_MESSAGES.unavailable });
    } finally {
      setBusy(false);
      setTimeout(() => bottom.current?.scrollIntoView({ behavior: 'smooth', block: 'end' }), 50);
    }
  }

  return (
    <div className={`mx-auto flex min-h-screen max-w-2xl flex-col ${embed ? 'px-3 py-3' : 'px-4 py-6'}`}>
      <header className={`flex items-center gap-3 ${embed ? 'mb-3' : 'mb-5'}`}>
        {config.logoUrl ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={config.logoUrl} alt={config.orgName} className="h-9 max-w-[160px] object-contain object-left" />
        ) : (
          <span aria-hidden="true" className="flex h-9 w-9 items-center justify-center rounded-xl bg-ws-accent text-base font-bold text-white">{config.orgName.slice(0, 1)}</span>
        )}
        <div className="min-w-0">
          <h1 className="truncate text-[17px] font-bold">{config.orgName} AI 민원 상담</h1>
          <p className="text-[12px] text-slate-500">AI가 기관이 공개한 안내 자료로 답합니다. 정확한 내용은 담당 부서에 확인해 주세요.</p>
        </div>
      </header>

      <div className="mb-3 rounded-xl border border-amber-200 bg-amber-50 px-4 py-2.5 text-[13px] text-amber-900">
        주민등록번호·전화번호·주소 같은 개인정보는 적지 마세요.{config.notice ? <span className="mt-1 block whitespace-pre-line text-slate-700">{config.notice}</span> : null}
      </div>

      <section aria-label="상담 내용" className="flex-1 space-y-4">
        {turns.length === 0 && config.faq.length > 0 && (
          <div>
            <p className="mb-2 text-[13px] font-medium text-slate-500">자주 묻는 질문</p>
            <div className="flex flex-wrap gap-2">
              {config.faq.map((q) => (
                <button key={q} type="button" onClick={() => void send(q)} disabled={busy} className="rounded-full border border-ws-accent/30 bg-white px-3 py-1.5 text-[13px] text-ws-accent-text hover:bg-ws-accent-soft disabled:opacity-50">{q}</button>
              ))}
            </div>
          </div>
        )}
        {turns.map((t, i) => (
          <div key={i} className="space-y-2">
            <p className="ml-auto max-w-[85%] whitespace-pre-line rounded-2xl rounded-br-md bg-ws-accent px-4 py-2.5 text-[14px] text-white">{t.question}</p>
            <div className="max-w-[92%] rounded-2xl rounded-bl-md border border-[#E7E9F1] bg-white px-4 py-3 text-[14px] leading-6">
              {t.state === 'error' ? (
                <p role="alert" className="text-red-700">{t.error}</p>
              ) : (
                <>
                  <p className="whitespace-pre-line">{t.answer || (t.state === 'streaming' ? '답을 찾고 있습니다…' : '')}</p>
                  {t.state === 'done' && t.sources && t.sources.length > 0 && (
                    <p className="mt-2 text-[12px] text-slate-500">근거: {t.sources.join(' / ')}</p>
                  )}
                  {t.state === 'done' && t.unverified && t.unverified.length > 0 && (
                    <p className="mt-1 text-[12px] text-amber-700">안내 자료에서 확인되지 않은 숫자가 있습니다: {t.unverified.join(' · ')} — 담당 부서에 확인해 주세요.</p>
                  )}
                  {t.state === 'done' && t.found === false && <p className="mt-2 text-[12px] text-slate-500">{PUBLIC_ASK_MESSAGES.noSource}</p>}
                </>
              )}
            </div>
            {(t.state === 'error' || t.found === false) && <Contacts contacts={config.contacts} />}
          </div>
        ))}
        <div ref={bottom} />
      </section>

      {config.contacts.length > 0 && turns.length === 0 && <div className="mt-4"><Contacts contacts={config.contacts} /></div>}

      <form
        className="sticky bottom-0 mt-4 flex gap-2 bg-[#F7F8FC] pb-1 pt-2"
        onSubmit={(e) => { e.preventDefault(); void send(draft); }}
      >
        <label htmlFor="public-ask-input" className="sr-only">질문</label>
        <textarea
          id="public-ask-input"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey && !isImeComposing(e)) { e.preventDefault(); void send(draft); } }}
          rows={2}
          maxLength={PUBLIC_ASK_QUESTION_MAX}
          placeholder="궁금한 점을 적어 주세요 (예: 수영장 환불은 어떻게 되나요?)"
          className="min-w-0 flex-1 resize-none rounded-xl border border-[#DCE3EC] bg-white px-3 py-2 text-[14px] focus:border-ws-accent focus:outline-none"
        />
        <button type="submit" disabled={busy || !draft.trim()} className="whitespace-nowrap rounded-xl bg-ws-accent px-4 text-[14px] font-semibold text-white hover:bg-ws-accent-hover disabled:opacity-40">{busy ? '답하는 중…' : '보내기'}</button>
      </form>
    </div>
  );
}

function Contacts({ contacts }: { contacts: PublicAskContact[] }) {
  if (contacts.length === 0) return null;
  return (
    <div className="rounded-xl border border-[#E7E9F1] bg-white px-4 py-3 text-[13px]">
      <p className="mb-1 font-medium text-slate-700">담당 부서 연락처</p>
      <ul className="space-y-0.5 text-slate-600">
        {contacts.map((c) => (
          <li key={`${c.name}-${c.phone}`}>{c.name}{c.phone ? ` · ${c.phone}` : ''}{c.note ? ` — ${c.note}` : ''}</li>
        ))}
      </ul>
    </div>
  );
}
