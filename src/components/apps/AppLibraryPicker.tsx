'use client';

import { useEffect, useState } from 'react';

export interface LibraryOption {
  id: string;
  title: string;
  file_type: string | null;
  effective_from: string | null;
}

/** 고른 문서 목록을 바꾼다 — 이미 고른 것은 빼고, 아니면 남은 자리(max)가 있을 때만 더한다 */
export function toggleLibraryPick(selected: string[], id: string, max: number): string[] {
  if (selected.includes(id)) return selected.filter((x) => x !== id);
  return selected.length < max ? [...selected, id] : selected;
}

/**
 * 입력형 앱의 '문서함에서 고르기'(2026-11-05) — 그 앱에 올려 둔 참고 문서(읽힌 현재 판만)에서 원자료로 쓸 문서를 고른다.
 * 목록은 서버(`/api/apps/library`)가 거른 것이고, 실행할 때 서버가 다시 본다. limit = 문서로 쓸 수 있는 자리(앱 상한 − 올린 파일 수).
 */
export default function AppLibraryPicker({
  agentId, selected, onChange, limit, disabled,
}: { agentId: string; selected: string[]; onChange: (ids: string[]) => void; limit: number; disabled?: boolean }) {
  const remaining = limit - selected.length;
  const [options, setOptions] = useState<LibraryOption[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    setOptions(null); setError(null);
    void (async () => {
      try {
        const res = await fetch(`/api/apps/library?agentId=${encodeURIComponent(agentId)}`);
        const body = await res.json().catch(() => null);
        if (!active) return;
        if (body?.ok) setOptions(body.data as LibraryOption[]);
        else setError(body?.error?.message ?? '문서 목록을 불러오지 못했습니다.');
      } catch {
        if (active) setError('문서 목록을 불러오지 못했습니다.');
      }
    })();
    return () => { active = false; };
  }, [agentId]);

  // 목록에서 사라진 문서(지난 판으로 내려감 등)는 고른 것에서도 뺀다
  useEffect(() => {
    if (!options) return;
    const keep = selected.filter((id) => options.some((o) => o.id === id));
    if (keep.length !== selected.length) onChange(keep);
  }, [options, selected, onChange]);

  return (
    <div className="space-y-2" aria-label="문서함에서 고르기">
      <p className="text-sm font-medium">문서함에서 고르기</p>
      <p className="text-xs leading-5 text-slate-500">이 앱에 올려 둔 참고 문서(읽힌 현재 판)를 원자료로 씁니다. 올린 파일과 합쳐 앱 상한까지 — 지금 {Math.max(0, remaining)}개 더 고를 수 있습니다.</p>
      {error && <p role="alert" className="text-xs text-red-700">{error}</p>}
      {!options && !error && <p role="status" className="text-xs text-slate-500">문서 목록을 불러오는 중…</p>}
      {options && options.length === 0 && <p className="text-xs text-slate-500">고를 수 있는 문서가 없습니다.</p>}
      {options && options.length > 0 && (
        <ul className="max-h-48 space-y-1 overflow-y-auto rounded-lg border border-slate-200 p-2">
          {options.map((o) => {
            const checked = selected.includes(o.id);
            return (
              <li key={o.id}>
                <label className="flex items-center gap-2 text-sm">
                  <input
                    type="checkbox"
                    checked={checked}
                    disabled={disabled || (!checked && remaining <= 0)}
                    onChange={() => onChange(toggleLibraryPick(selected, o.id, limit))}
                  />
                  <span className="min-w-0 truncate">{o.title}</span>
                  {o.effective_from && <span className="shrink-0 text-xs text-slate-500">시행 {o.effective_from}</span>}
                </label>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
