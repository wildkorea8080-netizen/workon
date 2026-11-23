'use client';

import { useEffect, useState } from 'react';
import { fetchOkJson } from '@/lib/ok-json';
import { CHAT_DOC_TAGS_MAX, DOC_TAGS_UNREAD, type AgentDocTag } from '@/lib/chat-doc-tags';

/**
 * 대화 입력창 위 '문서 좁히기'(2026-11-23) — 이 비서의 문서에 붙은 태그를 보여 주고, 고른 태그의 문서에서만 찾게 한다.
 * 태그가 붙은 문서가 없으면 아무것도 그리지 않는다. 못 읽으면 좁히지 않고 그렇다고 알린다(고른 것이 없으니 모든 문서에서 찾는다).
 * 고른 값은 다음 질문들에도 그대로 간다(다른 비서로 바꾸면 비운다 — 부르는 쪽이 key로 다시 그림).
 */
export default function DocTagFilter({ agentId, value, onChange, disabled }: {
  agentId: string;
  value: string[];
  onChange: (tags: string[]) => void;
  disabled?: boolean;
}) {
  const [tags, setTags] = useState<AgentDocTag[] | null>(null);
  const [unread, setUnread] = useState(false);

  useEffect(() => {
    let live = true;
    void fetchOkJson<{ data?: { tags?: AgentDocTag[] } }>(`/api/agents/${encodeURIComponent(agentId)}/document-tags`).then((r) => {
      if (!live) return;
      const list = r?.data?.tags;
      if (Array.isArray(list)) { setTags(list); setUnread(false); }
      else { setTags([]); setUnread(true); }
    });
    return () => { live = false; };
  }, [agentId]);

  if (unread) return <p role="status" className="mb-2 text-[11px] text-slate-500">{DOC_TAGS_UNREAD}</p>;
  if (!tags || tags.length === 0) return null;

  const chosen = new Set(value.map((t) => t.toLocaleLowerCase('ko')));
  const full = value.length >= CHAT_DOC_TAGS_MAX;
  const toggle = (tag: string) => {
    const key = tag.toLocaleLowerCase('ko');
    if (chosen.has(key)) onChange(value.filter((t) => t.toLocaleLowerCase('ko') !== key));
    else if (!full) onChange([...value, tag]);
  };

  return (
    <div className="mb-2 flex flex-wrap items-center gap-1.5 text-xs" role="group" aria-label="문서 좁히기">
      <span className="text-slate-500">문서 좁히기</span>
      {tags.map((t) => {
        const on = chosen.has(t.tag.toLocaleLowerCase('ko'));
        return (
          <button
            key={t.tag}
            type="button"
            aria-pressed={on}
            disabled={disabled || (!on && full)}
            onClick={() => toggle(t.tag)}
            title={`이 태그가 붙은 문서 ${t.count}개`}
            className={`rounded-full border px-2 py-0.5 disabled:opacity-40 ${on ? 'border-ws-accent bg-ws-accent/10 font-semibold text-ws-accent-text' : 'border-slate-200 bg-white text-slate-600 hover:border-slate-300'}`}
          >
            #{t.tag}
          </button>
        );
      })}
      {value.length > 0 && (
        <button type="button" disabled={disabled} onClick={() => onChange([])} className="text-slate-500 underline disabled:opacity-40">
          모두 풀기
        </button>
      )}
      {value.length > 0 && <span className="text-slate-400">고른 태그의 문서에서만 찾습니다(공통 기준 문서는 빠짐)</span>}
    </div>
  );
}
