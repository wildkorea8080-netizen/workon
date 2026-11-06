'use client';

import { useEffect, useState } from 'react';
import type { ReusableFile } from '@/lib/attachments/reuse-types';

/** 바이트 → 읽기 쉬운 크기 */
function sizeLabel(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)}MB`;
  return `${Math.max(1, Math.round(bytes / 1024))}KB`;
}

/**
 * 지난 파일 다시 붙이기(2026-11-05) — 최근 90일 안에 내가 대화에 붙였던 파일과 비서가 만들어 준 파일.
 * 고르면 서버가 새 첨부로 복사해 읽는다(옛 대화를 지워도 새 첨부는 남는다)
 */
export default function ReusableFilePicker({ disabled, onPick }: { disabled: boolean; onPick: (file: ReusableFile) => void }) {
  const [open, setOpen] = useState(false);
  const [files, setFiles] = useState<ReusableFile[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    let live = true;
    setError(null);
    setFiles(null);
    void fetch('/api/attachments/reusable')
      .then(async (res) => {
        const body = (await res.json().catch(() => null)) as { ok?: boolean; data?: ReusableFile[]; error?: { message?: string } } | null;
        if (!live) return;
        if (res.ok && body?.ok && Array.isArray(body.data)) setFiles(body.data);
        else setError(body?.error?.message ?? '지난 파일을 불러오지 못했습니다.');
      })
      .catch(() => live && setError('지난 파일을 불러오지 못했습니다.'));
    return () => { live = false; };
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open]);

  return (
    <div className="relative flex-shrink-0">
      <button
        type="button"
        disabled={disabled}
        onClick={() => setOpen((v) => !v)}
        aria-label="지난 파일 다시 붙이기"
        aria-expanded={open}
        title="최근 90일 안에 대화에 붙였던 파일·비서가 만들어 준 파일을 다시 붙입니다"
        className="h-8 rounded-lg px-2 text-xs font-medium text-slate-500 hover:text-ws-accent hover:bg-white disabled:text-slate-300 disabled:cursor-not-allowed"
      >
        지난 파일
      </button>
      {open && (
        <div role="dialog" aria-label="지난 파일" className="absolute bottom-10 left-0 z-30 w-80 max-w-[85vw] rounded-xl border border-slate-200 bg-white p-2 shadow-xl">
          <div className="flex items-center justify-between px-2 py-1">
            <span className="text-xs font-semibold text-slate-700">지난 파일 (최근 90일)</span>
            <button type="button" onClick={() => setOpen(false)} className="text-xs text-slate-400 hover:text-slate-700">닫기</button>
          </div>
          {error ? (
            <p role="alert" className="px-2 py-3 text-xs text-red-600">{error}</p>
          ) : files === null ? (
            <p role="status" className="px-2 py-3 text-xs text-slate-500">불러오는 중…</p>
          ) : files.length === 0 ? (
            <p className="px-2 py-3 text-xs text-slate-500">다시 붙일 파일이 없습니다.</p>
          ) : (
            <ul className="max-h-64 overflow-y-auto">
              {files.map((f) => (
                <li key={`${f.kind}:${f.id}`}>
                  <button
                    type="button"
                    onClick={() => { onPick(f); setOpen(false); }}
                    className="flex w-full items-center justify-between gap-2 rounded-lg px-2 py-1.5 text-left text-xs hover:bg-slate-50"
                  >
                    <span className="min-w-0 truncate text-slate-800" title={f.file_name}>{f.file_name}</span>
                    <span className="flex-shrink-0 text-[11px] text-slate-400">
                      {f.kind === 'generated' ? '만든 파일' : '첨부'} · {sizeLabel(f.size_bytes)} · {f.created_at.slice(5, 10).replace('-', '.')}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          )}
          <p className="px-2 pt-1 text-[11px] leading-4 text-slate-400">고른 파일은 새 첨부로 복사돼 이 대화에 붙습니다.</p>
        </div>
      )}
    </div>
  );
}
