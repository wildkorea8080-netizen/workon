'use client';

import { useState } from 'react';
import { MAX_VOCABULARY_TAGS, normalizeVocabulary, tagsOutsideVocabulary } from '@/lib/document-tags';

/** 화면이 받는 분류표(GET /api/documents/tag-vocabulary) */
export interface VocabularyState {
  tags: string[];
  restricted: boolean;
  updatedAt: string | null;
  canEdit: boolean;
}

interface Props {
  vocabulary: VocabularyState;
  /** 목록의 문서 — 쓰였지만 분류표에 없는 태그를 보이려고 */
  documents: { file_name: string; noda_status: string | null; tags?: string[] | null }[];
  onSaved: (next: VocabularyState) => void;
  /** 다른 관리자가 먼저 고쳤을 때 다시 불러오기 */
  onReload: () => void;
}

/**
 * 기관 태그 분류표(0061) — 문서 목록 위에 접어 둔다. 기관 전체 관리자만 고친다(서버가 다시 본다).
 * '분류표의 태그만 쓰기'를 켜도 이미 붙은 태그는 바뀌지 않는다 — 분류표에 없는 태그를 보이고 분류표에 더할 수 있게 한다
 */
export default function TagVocabularyPanel({ vocabulary, documents, onSaved, onReload }: Props) {
  const [edit, setEdit] = useState<{ text: string; restricted: boolean; error: string | null; saving: boolean } | null>(null);
  const outside = tagsOutsideVocabulary(documents, vocabulary.tags);

  const save = async () => {
    if (!edit) return;
    const checked = normalizeVocabulary(edit.text, edit.restricted);
    if (!checked.ok) { setEdit({ ...edit, error: checked.message }); return; }
    setEdit({ ...edit, saving: true, error: null });
    try {
      const res = await fetch('/api/documents/tag-vocabulary', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ tags: checked.vocabulary.tags, restricted: checked.vocabulary.restricted, baseUpdatedAt: vocabulary.updatedAt }),
      });
      const result = await res.json().catch(() => null);
      if (!result?.ok) {
        setEdit((e) => (e ? { ...e, saving: false, error: result?.error?.message ?? '태그 분류표를 저장하지 못했습니다.' } : e));
        if (result?.error?.code === 'conflict') onReload();
        return;
      }
      onSaved(result.data as VocabularyState);
      setEdit(null);
    } catch {
      setEdit((e) => (e ? { ...e, saving: false, error: '태그 분류표를 저장하지 못했습니다.' } : e));
    }
  };

  const addOutside = () => {
    if (!edit) return;
    const lines = edit.text.split(/[,\n]/).map((t) => t.trim()).filter(Boolean);
    setEdit({ ...edit, text: [...lines, ...outside.map((o) => o.tag)].join('\n'), error: null });
  };

  return (
    <details className="mb-3 rounded-lg border border-slate-200 bg-slate-50 px-3 py-2 text-sm" aria-label="기관 태그 분류표">
      <summary className="cursor-pointer text-slate-700">
        기관 태그 분류표 — {vocabulary.tags.length ? `${vocabulary.tags.length}개` : '없음'}
        {vocabulary.restricted && <span className="ml-2 rounded bg-amber-100 px-1.5 py-0.5 text-xs text-amber-800">분류표의 태그만 쓰기</span>}
      </summary>
      <div className="mt-2 space-y-2">
        <p className="text-xs text-slate-500">
          태그를 붙일 때와 AI 초안이 분류표의 표기를 먼저 씁니다. &lsquo;분류표의 태그만 쓰기&rsquo;를 켜면 분류표에 없는 태그는 저장하지 못합니다(이미 붙은 태그는 그대로 — 그 문서를 다시 저장할 때 맞춰야 합니다).
        </p>
        {!edit && (
          <div className="flex flex-wrap gap-1">
            {vocabulary.tags.map((t) => <span key={t} className="rounded bg-white px-1.5 py-0.5 text-xs text-slate-700 ring-1 ring-slate-200">#{t}</span>)}
            {vocabulary.tags.length === 0 && <span className="text-xs text-slate-400">아직 분류표가 없습니다.</span>}
          </div>
        )}
        {outside.length > 0 && (
          <p className="text-xs text-slate-500">
            문서에 쓰였지만 분류표에 없는 태그: {outside.slice(0, 20).map((o) => `${o.tag}(${o.count})`).join(', ')}{outside.length > 20 ? ` 외 ${outside.length - 20}개` : ''}
          </p>
        )}
        {vocabulary.canEdit && !edit && (
          <button
            type="button"
            onClick={() => setEdit({ text: vocabulary.tags.join('\n'), restricted: vocabulary.restricted, error: null, saving: false })}
            className="rounded-md border border-slate-300 bg-white px-2.5 py-1 text-xs text-slate-700"
          >
            분류표 고치기
          </button>
        )}
        {edit && (
          <div className="space-y-2">
            <textarea
              aria-label="분류표 태그(한 줄에 하나 또는 쉼표로)"
              value={edit.text}
              onChange={(e) => setEdit({ ...edit, text: e.target.value, error: null })}
              rows={6}
              placeholder={'여비\n복무\n계약'}
              className="w-full rounded-md border border-slate-300 px-2 py-1 text-xs"
            />
            <div className="flex flex-wrap items-center gap-3">
              <label className="flex items-center gap-1 text-xs text-slate-700">
                <input type="checkbox" checked={edit.restricted} onChange={(e) => setEdit({ ...edit, restricted: e.target.checked, error: null })} />
                분류표의 태그만 쓰기
              </label>
              <span className="text-xs text-slate-400">{MAX_VOCABULARY_TAGS}개까지 · 한 태그 20자</span>
              {outside.length > 0 && (
                <button type="button" onClick={addOutside} className="text-xs text-slate-600 underline">쓰이는 태그 모두 더하기</button>
              )}
            </div>
            <div className="flex items-center gap-2">
              <button type="button" disabled={edit.saving} onClick={() => void save()} className="rounded-md bg-slate-900 px-2.5 py-1 text-xs font-medium text-white disabled:opacity-40">저장</button>
              <button type="button" onClick={() => setEdit(null)} className="text-xs text-slate-500 underline">취소</button>
            </div>
            {edit.error && <p role="alert" className="text-xs text-red-600">{edit.error}</p>}
          </div>
        )}
      </div>
    </details>
  );
}
