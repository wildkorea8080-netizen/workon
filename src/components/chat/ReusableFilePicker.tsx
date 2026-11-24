'use client';

import { useEffect, useState } from 'react';
import type { ReusableFile } from '@/lib/attachments/reuse-types';
import { LIBRARY_UNFILED_LABEL, type LibraryFile, type LibraryFolder } from '@/lib/my-library-spec';

/** 바이트 → 읽기 쉬운 크기 */
function sizeLabel(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)}MB`;
  return `${Math.max(1, Math.round(bytes / 1024))}KB`;
}

/**
 * 지난 파일 다시 붙이기(2026-11-05) — 최근 90일 안에 내가 대화에 붙였던 파일과 비서가 만들어 준 파일,
 * 그리고 내 자료함(2026-11-24, 0103 — 폴더로 모아 둔 파일, 기간 없음).
 * 고르면 서버가 새 첨부로 복사해 읽는다(옛 대화를 지워도 새 첨부는 남는다). 서버가 주인·기관을 다시 본다
 */
export default function ReusableFilePicker({ disabled, onPick, placement = 'up', note = '고른 파일은 새 첨부로 복사돼 이 대화에 붙습니다.' }: {
  disabled: boolean; onPick: (file: ReusableFile) => void;
  /** 목록을 단추 위(대화 입력창)로 펼칠지 아래(입력형 앱 실행 화면 — 2026-11-08)로 펼칠지 */
  placement?: 'up' | 'down';
  /** 목록 아래 안내 — 고른 파일이 어디에 붙는지 */
  note?: string;
}) {
  const [open, setOpen] = useState(false);
  // 'recent' = 최근 90일 지난 파일, 'library' = 내 자료함(0103)
  // 'department' = 부서 자료함(0106)
  const [tab, setTab] = useState<'recent' | 'library' | 'department'>('recent');
  const [folder, setFolder] = useState<string | null>(null);
  const [folders, setFolders] = useState<LibraryFolder[]>([]);
  const [files, setFiles] = useState<ReusableFile[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    let live = true;
    setError(null);
    setFiles(null);
    const library = tab !== 'recent';
    const params = new URLSearchParams();
    if (tab === 'department') params.set('space', 'department');
    if (folder !== null) params.set('folder', folder);
    const url = library ? `/api/my-library${params.toString() ? `?${params.toString()}` : ''}` : '/api/attachments/reusable';
    const failText = library ? `${tab === 'department' ? '부서' : '내'} 자료함을 불러오지 못했습니다.` : '지난 파일을 불러오지 못했습니다.';
    void fetch(url)
      .then(async (res) => {
        const body = (await res.json().catch(() => null)) as { ok?: boolean; data?: unknown; error?: { message?: string } } | null;
        if (!live) return;
        if (!res.ok || !body?.ok) { setError(body?.error?.message ?? failText); return; }
        if (!library) {
          if (Array.isArray(body.data)) setFiles(body.data as ReusableFile[]);
          else setError(failText);
          return;
        }
        const data = body.data as { files?: LibraryFile[]; folders?: LibraryFolder[] } | null;
        if (!data || !Array.isArray(data.files)) { setError(failText); return; }
        setFolders(Array.isArray(data.folders) ? data.folders : []);
        setFiles(data.files.map((f) => ({ kind: 'library', id: f.id, file_name: f.file_name, size_bytes: f.size_bytes, created_at: f.created_at, folder: f.folder })));
      })
      .catch(() => live && setError(failText));
    return () => { live = false; };
  }, [open, tab, folder]);
  // 자료함을 바꾸면 폴더 고르기를 처음으로
  useEffect(() => { setFolder(null); setFolders([]); }, [tab]);

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
        title="최근 90일 안에 대화에 붙였던 파일·비서가 만들어 준 파일, 내 자료함의 파일을 다시 붙입니다"
        className="h-8 rounded-lg px-2 text-xs font-medium text-slate-500 hover:text-ws-accent hover:bg-white disabled:text-slate-300 disabled:cursor-not-allowed"
      >
        지난 파일
      </button>
      {open && (
        <div role="dialog" aria-label="지난 파일" className={`absolute ${placement === 'down' ? 'top-10' : 'bottom-10'} left-0 z-30 w-80 max-w-[85vw] rounded-xl border border-slate-200 bg-white p-2 shadow-xl`}>
          <div className="flex items-center justify-between px-2 py-1">
            <div role="tablist" aria-label="고를 곳" className="flex gap-1">
              <button type="button" role="tab" aria-selected={tab === 'recent'} onClick={() => setTab('recent')} className={`rounded px-1.5 py-0.5 text-xs font-semibold ${tab === 'recent' ? 'bg-slate-100 text-slate-800' : 'text-slate-500'}`}>최근 90일</button>
              <button type="button" role="tab" aria-selected={tab === 'library'} onClick={() => setTab('library')} className={`rounded px-1.5 py-0.5 text-xs font-semibold ${tab === 'library' ? 'bg-slate-100 text-slate-800' : 'text-slate-500'}`}>내 자료함</button>
              <button type="button" role="tab" aria-selected={tab === 'department'} onClick={() => setTab('department')} className={`rounded px-1.5 py-0.5 text-xs font-semibold ${tab === 'department' ? 'bg-slate-100 text-slate-800' : 'text-slate-500'}`}>부서 자료함</button>
            </div>
            <button type="button" onClick={() => setOpen(false)} className="text-xs text-slate-400 hover:text-slate-700">닫기</button>
          </div>
          {tab !== 'recent' && folders.length > 0 && (
            <div role="group" aria-label="폴더" className="flex flex-wrap gap-1 px-2 pb-1">
              <button type="button" aria-pressed={folder === null} onClick={() => setFolder(null)} className={`rounded-full border px-2 py-0.5 text-[11px] ${folder === null ? 'border-ws-accent text-ws-accent-text' : 'border-slate-200 text-slate-500'}`}>전체</button>
              {folders.map((f) => (
                <button key={f.name || '__unfiled'} type="button" aria-pressed={folder === f.name} onClick={() => setFolder(f.name)} className={`rounded-full border px-2 py-0.5 text-[11px] ${folder === f.name ? 'border-ws-accent text-ws-accent-text' : 'border-slate-200 text-slate-500'}`}>{f.name || LIBRARY_UNFILED_LABEL}</button>
              ))}
            </div>
          )}
          {error ? (
            <p role="alert" className="px-2 py-3 text-xs text-red-600">{error}</p>
          ) : files === null ? (
            <p role="status" className="px-2 py-3 text-xs text-slate-500">불러오는 중…</p>
          ) : files.length === 0 ? (
            <p className="px-2 py-3 text-xs text-slate-500">{tab === 'recent' ? '다시 붙일 파일이 없습니다.' : `${tab === 'department' ? '부서' : '내'} 자료함에 담은 파일이 없습니다. 결과물 화면에서 담을 수 있습니다.`}</p>
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
                      {f.kind === 'library' ? (f.folder || LIBRARY_UNFILED_LABEL) : f.kind === 'generated' ? '만든 파일' : '첨부'} · {sizeLabel(f.size_bytes)} · {f.created_at.slice(5, 10).replace('-', '.')}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          )}
          <p className="px-2 pt-1 text-[11px] leading-4 text-slate-400">{note}</p>
        </div>
      )}
    </div>
  );
}
