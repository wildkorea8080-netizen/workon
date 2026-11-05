'use client';

import { useState } from 'react';
import { applyVocabulary, normalizeDocumentTags, type TagVocabulary } from '@/lib/document-tags';
import { BATCH_DRAFT_CONCURRENCY, batchDraftTargets, draftResultOf, draftText, MAX_BATCH_DRAFTS, runDraftQueue } from '@/lib/document-tag-batch';

interface Doc {
  id: string;
  title?: string | null;
  file_name: string;
  noda_status: string | null;
  retired_at?: string | null;
  tags?: string[] | null;
}

type Row = {
  id: string;
  name: string;
  state: 'waiting' | 'drafting' | 'ready' | 'failed' | 'skipped' | 'saved';
  text: string;
  accept: boolean;
  message: string | null;
};

/**
 * 여러 문서에 한 번에 AI 태그 초안 — 지금 목록(거르기 적용)에서 태그 없는 문서 20개까지. 문서마다 서버가 권한·한도를 보고 사용량을 기록한다.
 * 초안은 저장하지 않는다: 사람이 고치고 고른 것만 저장한다(분류표 규칙은 화면이 먼저, 서버가 다시 본다)
 */
export default function TagBatchDraft({ documents, vocabulary, onSaved }: {
  /** 지금 목록에 보이는 문서(거르기 적용) */
  documents: Doc[];
  vocabulary: TagVocabulary | null;
  onSaved: (id: string, tags: string[]) => void;
}) {
  const [rows, setRows] = useState<Row[] | null>(null);
  const [running, setRunning] = useState(false);
  const [saving, setSaving] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const targets = batchDraftTargets(documents);
  const update = (id: string, patch: Partial<Row>) => setRows((prev) => prev?.map((r) => (r.id === id ? { ...r, ...patch } : r)) ?? prev);

  const start = async () => {
    if (!targets.length) return;
    if (!window.confirm(`태그가 없는 문서 ${targets.length}개에 AI 태그 초안을 만듭니다. 문서마다 AI 사용량이 기록됩니다. 계속할까요?`)) return;
    const byId = new Map(targets.map((d) => [d.id, d]));
    setRows(targets.map((d) => ({ id: d.id, name: d.title || d.file_name, state: 'waiting', text: (d.tags ?? []).join(', '), accept: false, message: null })));
    setNotice(null);
    setRunning(true);
    let stopMessage: string | null = null;
    await runDraftQueue(
      targets.map((d) => d.id),
      async (id) => {
        const res = await fetch(`/api/documents/${id}/tag-suggest`, { method: 'POST' });
        return draftResultOf(res.status, await res.json().catch(() => null));
      },
      {
        concurrency: BATCH_DRAFT_CONCURRENCY,
        onStart: (id) => update(id, { state: 'drafting' }),
        onResult: (id, result) => {
          if (result.kind === 'ok') {
            const text = draftText(byId.get(id)?.tags, result.suggestions);
            update(id, { state: 'ready', text, accept: result.suggestions.length > 0, message: result.suggestions.length ? null : '제안할 태그를 찾지 못했습니다.' });
          } else if (result.kind === 'skipped') {
            update(id, { state: 'skipped', message: '건너뜀' });
          } else {
            if (result.kind === 'stop') stopMessage = result.message;
            update(id, { state: 'failed', message: result.message });
          }
        },
      }
    );
    setRunning(false);
    setNotice(stopMessage ? `${stopMessage} — 남은 문서는 부르지 않았습니다.` : '초안을 다 만들었습니다. 확인하고 고친 뒤 고른 것을 저장하세요.');
  };

  const saveChosen = async () => {
    if (!rows) return;
    const chosen = rows.filter((r) => r.accept && r.state === 'ready');
    // 저장 전에 모두 다듬어 본다 — 하나라도 틀리면 저장하지 않고 그 줄에 알린다
    const prepared: { id: string; tags: string[] }[] = [];
    let bad = false;
    for (const r of chosen) {
      const checked = normalizeDocumentTags(r.text);
      const fitted = checked.ok ? (vocabulary ? applyVocabulary(checked.tags, vocabulary) : { ok: true as const, tags: checked.tags }) : checked;
      if (!fitted.ok) { update(r.id, { message: fitted.message }); bad = true; continue; }
      prepared.push({ id: r.id, tags: fitted.tags });
    }
    if (bad) { setNotice('고친 태그를 확인해 주세요 — 저장하지 않았습니다.'); return; }
    setSaving(true);
    let saved = 0;
    for (const p of prepared) {
      try {
        const res = await fetch(`/api/documents/${p.id}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ tags: p.tags }) });
        const result = await res.json().catch(() => null);
        if (!result?.ok) { update(p.id, { message: result?.error?.message ?? '태그를 저장하지 못했습니다.' }); continue; }
        onSaved(p.id, result.data.tags as string[]);
        update(p.id, { state: 'saved', accept: false, message: '저장함' });
        saved += 1;
      } catch {
        update(p.id, { message: '태그를 저장하지 못했습니다.' });
      }
    }
    setSaving(false);
    setNotice(`${saved}/${prepared.length}개 저장했습니다.`);
  };

  if (!rows) {
    return (
      <button
        type="button"
        disabled={!targets.length}
        onClick={() => void start()}
        className="rounded-md border border-slate-300 px-2.5 py-1.5 text-xs text-slate-700 disabled:opacity-40"
        title={`지금 목록에서 태그가 없는 문서 ${MAX_BATCH_DRAFTS}개까지 AI가 태그를 제안합니다(저장은 직접) — 문서마다 AI 사용량이 기록됩니다`}
      >
        태그 없는 문서 AI 초안({targets.length}개)
      </button>
    );
  }

  const label: Record<Row['state'], string> = { waiting: '기다림', drafting: '만드는 중…', ready: '초안', failed: '실패', skipped: '건너뜀', saved: '저장함' };
  return (
    <div className="w-full space-y-2 rounded-lg border border-slate-200 bg-slate-50 p-3" aria-label="여러 문서 태그 초안">
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-sm font-medium text-slate-800">여러 문서 태그 초안</span>
        {running && <span role="status" className="text-xs text-slate-500">{rows.filter((r) => r.state !== 'waiting' && r.state !== 'drafting').length}/{rows.length} 끝남</span>}
        <button type="button" disabled={running || saving || !rows.some((r) => r.accept && r.state === 'ready')} onClick={() => void saveChosen()} className="ml-auto rounded-md bg-slate-900 px-2.5 py-1 text-xs font-medium text-white disabled:opacity-40">{saving ? '저장 중…' : '고른 것 저장'}</button>
        <button type="button" disabled={running || saving} onClick={() => { setRows(null); setNotice(null); }} className="text-xs text-slate-500 underline disabled:opacity-40">닫기</button>
      </div>
      {notice && <p role="status" className="text-xs text-slate-600">{notice}</p>}
      <ul className="space-y-1">
        {rows.map((r) => (
          <li key={r.id} className="flex flex-wrap items-center gap-2 text-xs">
            <input type="checkbox" aria-label={`${r.name} 저장할 것으로 고르기`} disabled={r.state !== 'ready' || saving} checked={r.accept} onChange={(e) => update(r.id, { accept: e.target.checked })} />
            <span className="w-48 truncate text-slate-800" title={r.name}>{r.name}</span>
            <span className="w-16 text-slate-500">{label[r.state]}</span>
            <input
              aria-label={`${r.name} 태그`}
              value={r.text}
              disabled={r.state !== 'ready' || saving}
              onChange={(e) => update(r.id, { text: e.target.value, message: null })}
              className="min-w-[12rem] flex-1 rounded-md border border-slate-300 px-2 py-0.5 disabled:bg-slate-100"
            />
            {r.message && <span className={r.state === 'failed' ? 'text-red-600' : 'text-slate-500'}>{r.message}</span>}
          </li>
        ))}
      </ul>
    </div>
  );
}
