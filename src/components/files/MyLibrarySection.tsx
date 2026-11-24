'use client';

import { useEffect, useRef, useState } from 'react';
import { Card, ErrorNote } from '@/components/work/WorkShell';
import { api, formatBytes, formatDateTime } from '@/lib/work/client';
import { fileBadge } from '@/lib/file-badge';
import { emptyListText } from '@/lib/ok-json';
import { useInFlight } from '@/lib/use-in-flight';
import { uploadAttachment } from '@/lib/attachments/upload-client';
import { ATTACHMENT_ACCEPT } from '@/lib/attachments/limits';
import {
  LIBRARY_SOURCE_LABEL, LIBRARY_SPACE_LABEL, LIBRARY_UNFILED_LABEL,
  type LibraryFile, type LibraryFolder, type LibrarySpace,
} from '@/lib/my-library-spec';

type Page = { space: LibrarySpace; files: LibraryFile[]; next: string | null; folders: LibraryFolder[]; total: number; limit: number; canManage: boolean };

/** 폴더 이름을 묻는다 — 취소면 null, 빈 글은 미분류 */
export function askFolder(message: string, current: string): string | null {
  const answer = window.prompt(`${message}\n(비우면 '${LIBRARY_UNFILED_LABEL}' — / 없이 30자까지)`, current);
  return answer === null ? null : answer.trim();
}

/**
 * 내 자료함(2026-11-24, 0103) — 자주 쓰는 파일을 폴더로 모아 두고 대화·입력형 앱의 '지난 파일'에서 다시 붙인다.
 * 사본이라 대화를 지워도 남는다. 내 것만 보인다(관리자도 못 본다)
 */
export default function MyLibrarySection({ query, refreshKey, space, onSpaceChange }: {
  query: string; refreshKey: number;
  /** 내 자료함 · 부서 자료함(0106) — 결과물 화면의 '담기'도 이 자리로 담는다 */
  space: LibrarySpace; onSpaceChange: (space: LibrarySpace) => void;
}) {
  const [page, setPage] = useState<Page | null>(null);
  const [folder, setFolder] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [unread, setUnread] = useState(false);
  const [loading, setLoading] = useState(false);
  const latest = useRef(0);
  const action = useInFlight();

  const load = async (cursor: string | null) => {
    const seq = ++latest.current;
    setLoading(true);
    const params = new URLSearchParams();
    if (space === 'department') params.set('space', 'department');
    if (folder !== null) params.set('folder', folder);
    if (query) params.set('q', query);
    if (cursor) params.set('cursor', cursor);
    const r = await api<Page>(`/api/my-library${params.toString() ? `?${params.toString()}` : ''}`);
    if (seq !== latest.current) return; // 늦게 온 옛 응답은 버린다
    setLoading(false);
    if (!r.ok) {
      setError(r.error.message);
      if (!cursor) { setPage(null); setUnread(true); } // '더 보기' 실패는 읽은 쪽을 그대로 둔다
      return;
    }
    setError(null);
    setUnread(false);
    setPage((prev) => (cursor && prev ? { ...r.data, files: [...prev.files, ...r.data.files] } : r.data));
  };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => { void load(null); }, [query, folder, refreshKey, space]);
  // 자리를 바꾸면 폴더 고르기를 처음으로(다른 자리의 폴더 이름은 뜻이 없다)
  useEffect(() => { setFolder(null); setNotice(null); }, [space]);
  const spaceParam = space === 'department' ? '?space=department' : '';

  const done = async (message: string) => { setNotice(message); await load(null); };

  const upload = (file: File) => action.run('upload', async () => {
    setError(null);
    setNotice(null);
    const target = askFolder(`'${file.name}'을(를) 담을 폴더`, folder ?? '');
    if (target === null) return;
    // 대화 첨부와 같은 길로 올려 읽어 본 뒤(다시 붙일 수 있는 파일만) 자료함에 사본을 담고, 올린 첨부는 치운다
    const uploaded = await uploadAttachment(file, () => {});
    if (!uploaded.ok) { setError(uploaded.message); return; }
    const staged = uploaded.attachment;
    try {
      if (staged.status !== 'ready') { setError(staged.error ?? '파일을 읽지 못해 담지 않았습니다.'); return; }
      const saved = await api<LibraryFile>('/api/my-library', { method: 'POST', json: { kind: 'attachment', id: staged.id, folder: target, space } });
      if (!saved.ok) { setError(saved.error.message); return; }
      await done(`'${saved.data.file_name}'을(를) ${LIBRARY_SPACE_LABEL[space]} ${saved.data.folder || LIBRARY_UNFILED_LABEL}에 담았습니다.`);
    } finally {
      void fetch(`/api/attachments/${encodeURIComponent(staged.id)}`, { method: 'DELETE' }).catch(() => {});
    }
  });

  const rename = (f: LibraryFile) => action.run(`rename:${f.id}`, async () => {
    const name = window.prompt('새 파일 이름(확장자는 그대로)', f.file_name);
    if (name === null || name.trim() === f.file_name) return;
    const r = await api<LibraryFile>(`/api/my-library/${encodeURIComponent(f.id)}`, { method: 'PATCH', json: { file_name: name, space } });
    if (!r.ok) { setError(r.error.message); return; }
    setError(null);
    await done(`이름을 '${r.data.file_name}'(으)로 바꿨습니다.`);
  });

  const move = (f: LibraryFile) => action.run(`move:${f.id}`, async () => {
    const target = askFolder(`'${f.file_name}'을(를) 옮길 폴더`, f.folder);
    if (target === null || target === f.folder) return;
    const r = await api<LibraryFile>(`/api/my-library/${encodeURIComponent(f.id)}`, { method: 'PATCH', json: { folder: target, space } });
    if (!r.ok) { setError(r.error.message); return; }
    setError(null);
    await done(`'${r.data.file_name}'을(를) ${r.data.folder || LIBRARY_UNFILED_LABEL}(으)로 옮겼습니다.`);
  });

  const remove = (f: LibraryFile) => action.run(`remove:${f.id}`, async () => {
    if (!window.confirm(`'${f.file_name}'을(를) ${LIBRARY_SPACE_LABEL[space]}에서 지웁니다. 되돌릴 수 없습니다${space === 'department' ? '(부서 사람 모두에게서 사라집니다' : '('}이 파일을 붙여 보낸 대화는 그대로입니다).`)) return;
    const r = await api<{ id: string }>(`/api/my-library/${encodeURIComponent(f.id)}${spaceParam}`, { method: 'DELETE' });
    if (!r.ok) { setError(r.error.message); return; }
    setError(null);
    await done(`'${f.file_name}'을(를) 지웠습니다.`);
  });

  const folders = page?.folders ?? [];
  const busy = action.running !== null;
  return (
    <section aria-label="자료함" className="mt-8">
      <div role="tablist" aria-label="자료함 고르기" className="mb-3 flex gap-2">
        {(['personal', 'department'] as const).map((s) => (
          <button key={s} type="button" role="tab" aria-selected={space === s} onClick={() => onSpaceChange(s)}
            className={`rounded-lg px-3 py-1.5 text-[15px] font-semibold ${space === s ? 'bg-ws-accent/10 text-ws-accent-text' : 'text-slate-500 hover:text-slate-800'}`}>{LIBRARY_SPACE_LABEL[s]}</button>
        ))}
      </div>
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h2 className="text-[17px] font-semibold text-slate-900">{LIBRARY_SPACE_LABEL[space]}</h2>
          <p className="mt-1 text-[13px] text-slate-500">{space === 'department'
            ? '우리 부서 사람이 함께 쓰는 파일입니다(지금 소속 부서만 — 상위·하위 부서는 따로). 누구나 담고 다시 붙일 수 있고, 이름·폴더 바꾸기와 지우기는 담은 사람이나 관리자만 합니다. 담은 사람이 부서를 옮기거나 퇴직해도 남습니다.'
            : '자주 쓰는 파일을 폴더로 모아 둡니다. 대화·입력형 앱의 ‘지난 파일’에서 다시 붙일 수 있고, 대화를 지워도 남습니다. 나만 봅니다.'}</p>
        </div>
        <label className={`rounded-lg border border-[#DCE3EC] px-3 py-1.5 text-[14px] ${busy ? 'opacity-50' : 'cursor-pointer hover:border-[#003087]'}`}>
          {action.running === 'upload' ? '올리는 중…' : '파일 올려 담기'}
          <input type="file" aria-label={`${LIBRARY_SPACE_LABEL[space]}에 파일 올리기`} accept={ATTACHMENT_ACCEPT} disabled={busy} className="sr-only"
            onChange={(e) => { const file = e.target.files?.[0]; e.target.value = ''; if (file) void upload(file); }} />
        </label>
      </div>
      {page && <p className="mt-2 text-[13px] text-slate-500">{page.total} / {page.limit}개</p>}
      <div role="group" aria-label="폴더" className="mt-3 mb-3 flex flex-wrap gap-2">
        <button type="button" aria-pressed={folder === null} onClick={() => setFolder(null)}
          className={`rounded-full border px-3 py-1 text-[13px] ${folder === null ? 'border-ws-accent bg-ws-accent/10 text-ws-accent-text' : 'border-[#DCE3EC] text-slate-600'}`}>전체</button>
        {folders.map((f) => (
          <button key={f.name || '__unfiled'} type="button" aria-pressed={folder === f.name} onClick={() => setFolder(f.name)}
            className={`rounded-full border px-3 py-1 text-[13px] ${folder === f.name ? 'border-ws-accent bg-ws-accent/10 text-ws-accent-text' : 'border-[#DCE3EC] text-slate-600'}`}>
            {f.name || LIBRARY_UNFILED_LABEL} <span className="text-slate-400">{f.count}</span>
          </button>
        ))}
      </div>
      <ErrorNote message={error} />
      {notice && <p role="status" className="mb-3 text-[13px] text-ws-accent-text">{notice}</p>}
      <Card className="p-0 overflow-x-auto">
        {(unread && !page) || (page && page.files.length === 0) ? (
          <div className="p-6 text-[15px] text-slate-600">
            {unread && !page ? emptyListText(true, '', `${LIBRARY_SPACE_LABEL[space]}을`) : query ? `'${query}'이(가) 이름에 든 파일이 없습니다.` : folder !== null ? '이 폴더에 담은 파일이 없습니다.' : `아직 담은 파일이 없습니다. 위 ‘파일 올려 담기’나 아래 목록의 ‘${LIBRARY_SPACE_LABEL[space]}에 담기’로 담으세요.`}
          </div>
        ) : (
          <table className="w-full min-w-[720px] text-left text-[15px]">
            <thead className="border-b border-[#DCE3EC] text-[13px] text-slate-500">
              <tr>
                <th scope="col" className="px-5 py-3 font-medium">파일</th>
                <th scope="col" className="px-5 py-3 font-medium">폴더</th>
                <th scope="col" className="px-5 py-3 font-medium">{space === 'department' ? '담은 사람' : '담은 곳'}</th>
                <th scope="col" className="px-5 py-3 font-medium">담은 때</th>
                <th scope="col" className="px-5 py-3 font-medium"><span className="sr-only">조작</span></th>
              </tr>
            </thead>
            <tbody>
              {(page?.files ?? []).map((f) => (
                <tr key={f.id} className="border-b border-[#DCE3EC] last:border-0">
                  <td className="px-5 py-3">
                    <span className="mr-2 rounded border border-[#DCE3EC] px-1.5 py-0.5 text-[12px] font-semibold">{fileBadge(f.file_name)}</span>
                    {f.file_name} <span className="text-[13px] text-slate-500">{formatBytes(f.size_bytes)}</span>
                  </td>
                  <td className="px-5 py-3 text-slate-600">{f.folder || LIBRARY_UNFILED_LABEL}</td>
                  <td className="px-5 py-3 text-slate-600">{space === 'department' ? (f.mine ? '나' : f.added_by ?? '—') : LIBRARY_SOURCE_LABEL[f.source]}</td>
                  <td className="px-5 py-3 text-[14px] text-slate-500">{formatDateTime(f.created_at)}</td>
                  <td className="whitespace-nowrap px-5 py-3 text-right text-[14px]">
                    <a href={`/api/my-library/${encodeURIComponent(f.id)}/original`} className="rounded-lg border border-[#DCE3EC] px-3 py-1.5 hover:border-[#003087]">내려받기</a>
                    {/* 부서 자료함에서 남이 담은 파일은 관리자만 바꾼다(서버가 다시 본다) */}
                    {(f.mine || page?.canManage) && <>
                      <button type="button" disabled={busy} onClick={() => void rename(f)} className="ml-2 text-slate-600 underline disabled:opacity-50">이름</button>
                      <button type="button" disabled={busy} onClick={() => void move(f)} className="ml-2 text-slate-600 underline disabled:opacity-50">옮기기</button>
                      <button type="button" disabled={busy} onClick={() => void remove(f)} className="ml-2 text-red-600 underline disabled:opacity-50">지우기</button>
                    </>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Card>
      {page?.next && (
        <button type="button" onClick={() => void load(page.next)} disabled={loading} className="mt-3 rounded-lg border border-[#DCE3EC] px-3 py-1.5 text-[14px] disabled:opacity-50">
          {loading ? '불러오는 중…' : '더 보기'}
        </button>
      )}
    </section>
  );
}
