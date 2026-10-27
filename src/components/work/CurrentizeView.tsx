'use client';

import { useState } from 'react';
import { Card } from './WorkShell';
import type { CurrentizeChangeDto, CurrentizeDto } from './types';
import { FILTERS, canSave, citationFor, countByStatus, draftFor, editableChange, filterChanges, kindLabel, statusLabel, type ChangeFilter } from './currentize-view-helpers';

const STATUS_TONE: Record<CurrentizeChangeDto['status'], string> = {
  changed: 'bg-emerald-50 text-emerald-800 border-emerald-200',
  needs_check: 'bg-amber-50 text-amber-900 border-amber-200',
  proposed: 'bg-blue-50 text-blue-900 border-blue-200',
};
const CITATION_STATUS: Record<string, string> = { same: '같음', changed: '바뀜', not_found: '찾지 못함' };

/**
 * 현행화 '대조' 보기 — 변경마다 작년 글(왼쪽)과 올해 글(오른쪽). 확인 필요에는 올해 글을 넣고, 제안은 받아들이고, 바꿈은 고친다.
 * 저장하면 새 판이 생기고 그 판의 HWPX·변경 내역표를 다시 만든다(파일에 들어가는 것은 '바꿈'뿐).
 */
export default function CurrentizeView({ content, canEdit, busy, onEdit }: { content: CurrentizeDto; canEdit: boolean; busy: boolean; onEdit: (changeId: string, after: string) => Promise<void> }) {
  const [filter, setFilter] = useState<ChangeFilter>(() => (content.changes.some((c) => c.status === 'needs_check') ? 'needs_check' : 'all'));
  const counts = countByStatus(content.changes);
  const shown = filterChanges(content.changes, filter);

  return (
    <Card>
      <h2 className="text-[16px] font-semibold">
        대조 — {content.fromYear}년 → {content.toYear}년
      </h2>
      <p className="mt-1 text-[13px] text-slate-600">
        파일에는 &lsquo;바꿈&rsquo;만 들어갔습니다. &lsquo;확인 필요&rsquo;는 올해 글을 넣고, &lsquo;제안&rsquo;은 맞으면 그대로 저장해 받아들이세요. 저장할 때마다 새 판과 파일을 만듭니다.
      </p>
      {(content.costStopped || content.truncated) && (
        <p className="mt-2 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-[13px] text-red-800">
          {content.costStopped ? '원가 상한으로 일부 문장을 현행화하지 못했습니다. ' : ''}
          {content.truncated ? '작년 파일이 길어 앞부분만 현행화했습니다.' : ''}
        </p>
      )}
      {content.warnings.length > 0 && (
        <ul className="mt-2 list-disc pl-5 text-[13px] text-amber-800">
          {content.warnings.map((w) => (
            <li key={w}>{w}</li>
          ))}
        </ul>
      )}

      <div role="tablist" aria-label="변경 거르기" className="mt-3 flex flex-wrap gap-1 rounded-[10px] bg-slate-100 p-1">
        {FILTERS.map(([k, label]) => (
          <button key={k} role="tab" aria-selected={filter === k} onClick={() => setFilter(k)} className={`rounded-lg px-3 py-1.5 text-[14px] ${filter === k ? 'bg-white font-semibold shadow-sm' : 'text-slate-600'}`}>
            {label} {counts[k]}
          </button>
        ))}
      </div>

      {shown.length === 0 ? (
        <p className="mt-3 text-[14px] text-slate-500">해당하는 변경이 없습니다.</p>
      ) : (
        <ol className="mt-3 space-y-3">
          {shown.map((c) => (
            <ChangeCard key={c.id} change={c} content={content} canEdit={canEdit} busy={busy} onEdit={onEdit} />
          ))}
        </ol>
      )}
    </Card>
  );
}

function ChangeCard({ change, content, canEdit, busy, onEdit }: { change: CurrentizeChangeDto; content: CurrentizeDto; canEdit: boolean; busy: boolean; onEdit: (changeId: string, after: string) => Promise<void> }) {
  const [draft, setDraft] = useState(() => draftFor(change, content.changes));
  const [saving, setSaving] = useState(false);
  const editable = editableChange(change);
  const citations = change.kind === 'citation' ? citationFor(content, change.segmentId) : [];

  async function save() {
    setSaving(true);
    try {
      await onEdit(change.id, draft);
    } finally {
      setSaving(false);
    }
  }

  return (
    <li id={`change-${change.id}`} className="rounded-lg border border-[#DCE3EC] p-3 text-[14px]">
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-medium">{change.id}</span>
        <span className="text-slate-600">{change.location ?? '위치 모름'}</span>
        <span className="rounded-full border border-slate-200 bg-slate-50 px-2 py-0.5 text-[12px] text-slate-700">{kindLabel(change.kind)}</span>
        <span className={`rounded-full border px-2 py-0.5 text-[12px] ${STATUS_TONE[change.status]}`}>{statusLabel(change.status)}</span>
        {change.basis.includes('user') && <span className="text-[12px] text-slate-500">직접 수정</span>}
      </div>

      <div className="mt-2 grid gap-2 md:grid-cols-2">
        <div>
          <div className="text-[12px] font-semibold text-slate-500">작년 글</div>
          <p className="mt-1 whitespace-pre-wrap rounded-[10px] bg-slate-50 px-3 py-2 text-slate-800">{change.before || <span className="text-slate-400">(빈 칸)</span>}</p>
        </div>
        <div>
          <div className="text-[12px] font-semibold text-slate-500">올해 글</div>
          {canEdit && editable.ok ? (
            <textarea
              aria-label={`${change.id} 올해 글`}
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              rows={Math.min(8, Math.max(2, Math.ceil(draft.length / 40)))}
              disabled={busy || saving}
              className="mt-1 w-full rounded-[10px] border border-[#DCE3EC] px-3 py-2 text-[14px] disabled:bg-slate-50"
            />
          ) : (
            <p className="mt-1 whitespace-pre-wrap rounded-[10px] bg-slate-50 px-3 py-2 text-slate-800">{change.after ?? <span className="text-slate-400">(아직 없음)</span>}</p>
          )}
        </div>
      </div>

      {change.note && <p className="mt-2 text-[13px] text-amber-800">{change.note}</p>}
      {!editable.ok && <p className="mt-1 text-[13px] text-slate-600">{editable.reason}</p>}
      {change.basis.filter((b) => b !== 'user').length > 0 && <p className="mt-1 text-[12px] text-slate-500">근거: {change.basis.filter((b) => b !== 'user').join(', ')}</p>}

      {citations.length > 0 && (
        <details className="mt-2">
          <summary className="cursor-pointer text-[13px] text-[#003087]">인용한 조문 — 작년 글과 지금 조문</summary>
          <ul className="mt-2 space-y-2">
            {citations.map((p, i) => (
              <li key={i} className="rounded-[10px] border border-slate-200 p-2 text-[13px]">
                <div className="font-medium">
                  {p.cited.name} {p.cited.article ?? ''} · {CITATION_STATUS[p.status] ?? p.status}
                </div>
                <p className="mt-1 whitespace-pre-wrap text-slate-700">작년 글: {p.cited.text || '(없음)'}</p>
                {p.current ? (
                  <>
                    <p className="mt-1 whitespace-pre-wrap text-slate-700">
                      지금 조문({p.current.title}
                      {p.current.article ? ` ${p.current.article}` : ''}): {p.current.text}
                    </p>
                    <p className="text-[12px] text-slate-500">시행일: {p.current.enforced ?? '확인 못함'}</p>
                  </>
                ) : (
                  <p className="mt-1 text-slate-500">지금 조문을 찾지 못했습니다.</p>
                )}
              </li>
            ))}
          </ul>
        </details>
      )}

      {canEdit && editable.ok && (
        <button
          onClick={save}
          disabled={busy || saving || !canSave(change, draft)}
          className="mt-2 rounded-[10px] bg-[#003087] px-4 py-2 text-[14px] font-semibold text-white disabled:bg-slate-300"
        >
          {saving ? '저장 중…' : change.status === 'proposed' ? '이 글로 받아들이기' : '올해 글 저장'}
        </button>
      )}
    </li>
  );
}
