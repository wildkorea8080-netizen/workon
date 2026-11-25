'use client';

import { Fragment, useEffect, useRef, useState } from 'react';
import { Card, ErrorNote } from '@/components/work/WorkShell';
import { api, formatBytes, formatDateTime } from '@/lib/work/client';
import { fileBadge } from '@/lib/file-badge';
import { emptyListText } from '@/lib/ok-json';
import { useInFlight } from '@/lib/use-in-flight';
import { uploadAttachment } from '@/lib/attachments/upload-client';
import { ATTACHMENT_ACCEPT } from '@/lib/attachments/limits';
import {
  folderLabel, folderTree, isSharedLibrarySpace, LIBRARY_CONTENT_SEARCH_NOTE, libraryPlaceLabel, transferPlaces, LIBRARY_FOLDER_DEPTH, LIBRARY_SOURCE_LABEL, LIBRARY_SPACES, LIBRARY_UNFILED_LABEL,
  type LibraryFile, type LibraryFolder, type LibraryPlace, type LibraryShare, type LibrarySpace,
} from '@/lib/my-library-spec';

type Page = { space: LibrarySpace; share?: string | null; shares?: LibraryShare[]; files: LibraryFile[]; next: string | null; folders: LibraryFolder[]; total: number; limit: number; canManage: boolean; canAdd?: boolean; canAddTo?: Record<LibrarySpace, boolean> };

/** 보낼 곳 고르기 값 — 공유 자료함은 `shared:{id}` */
const placeKey = (p: LibraryPlace) => (p.space === 'shared' ? `shared:${p.share ?? ''}` : p.space);
const placeOf = (key: string): LibraryPlace => (key.startsWith('shared:') ? { space: 'shared', share: key.slice(7) } : { space: key as LibrarySpace });
type TransferMode = 'copy' | 'move';
/** 다른 자료함으로 보내기(0296) — 고르는 중인 파일·보낼 곳·방식·폴더 */
type TransferWhat = { kind: 'file'; file: LibraryFile } | { kind: 'files'; ids: string[]; names: string[] } | { kind: 'folder'; folder: string };
type TransferDraft = { what: TransferWhat; to: LibraryPlace; mode: TransferMode; folder: string; canMove: boolean };
type BatchResult = { sent: number; failed: { id: string; file_name: string; message: string }[]; warnings: string[] };

/** 자리마다 설명 — 누가 보고 누가 담는지 */
const SPACE_NOTE: Record<LibrarySpace, string> = {
  personal: '자주 쓰는 파일을 폴더로 모아 둡니다. 대화·입력형 앱의 ‘지난 파일’에서 다시 붙일 수 있고, 대화를 지워도 남습니다. 나만 봅니다.',
  department: '우리 부서 사람이 함께 쓰는 파일입니다(지금 소속 부서만 — 상위·하위 부서는 따로). 누구나 담고 다시 붙일 수 있고, 이름·폴더 바꾸기와 지우기는 담은 사람이나 관리자만 합니다. 담은 사람이 부서를 옮기거나 퇴직해도 남습니다.',
  organization: '기관 직원 모두가 함께 보는 파일입니다(공통 서식·기준 자료 등). 누구나 내려받고 대화·입력형 앱에 다시 붙일 수 있고, 담기·이름/폴더 바꾸기·지우기는 기관 전체 관리자만 합니다.',
  shared: '기관 전체 관리자가 고른 여러 부서의 사람이 함께 쓰는 파일입니다(지금 소속 부서가 든 공유 자료함만 보입니다). 누구나 담고 다시 붙일 수 있고, 이름·폴더 바꾸기와 지우기는 담은 사람이나 관리자만 합니다.',
};

/** 폴더 이름을 묻는다 — 취소면 null, 빈 글은 미분류 */
export function askFolder(message: string, current: string): string | null {
  const answer = window.prompt(`${message}\n(비우면 '${LIBRARY_UNFILED_LABEL}' — / 로 나눠 ${LIBRARY_FOLDER_DEPTH}단계까지, 예: 예산/2026)`, current);
  return answer === null ? null : answer.trim();
}

/**
 * 내 자료함(2026-11-24, 0103) — 자주 쓰는 파일을 폴더로 모아 두고 대화·입력형 앱의 '지난 파일'에서 다시 붙인다.
 * 사본이라 대화를 지워도 남는다. 내 것만 보인다(관리자도 못 본다)
 */
export default function MyLibrarySection({ query, refreshKey, space, share = null, onSpaceChange, onCanAddChange, onSharesChange }: {
  query: string; refreshKey: number;
  /** (0116) 공유 자료함이면 어느 것인지 */
  share?: string | null;
  /** (0116) 내가 든 공유 자료함 — 결과물 화면의 '담기' 문구가 이름을 쓴다 */
  onSharesChange?: (shares: LibraryShare[]) => void;
  /** 내 자료함 · 부서 자료함(0106) · 기관 자료함(0112) — 결과물 화면의 '담기'도 이 자리로 담는다 */
  space: LibrarySpace; onSpaceChange: (space: LibrarySpace, share?: string) => void;
  /** 이 자리에 담을 수 있는가(기관 자료함은 기관 전체 관리자만) — 결과물 화면의 '담기' 단추를 숨긴다 */
  onCanAddChange?: (canAdd: boolean) => void;
}) {
  const [page, setPage] = useState<Page | null>(null);
  const [folder, setFolder] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [unread, setUnread] = useState(false);
  const [loading, setLoading] = useState(false);
  const latest = useRef(0);
  const action = useInFlight();
  const [transfer, setTransfer] = useState<TransferDraft | null>(null);
  // 여러 파일 고르기(0298) — 이 자리·이 목록의 파일 id
  const [selected, setSelected] = useState<string[]>([]);
  // 내가 든 공유 자료함(0116) — 목록 응답마다 다시 받는다
  const [shares, setShares] = useState<LibraryShare[]>([]);
  const here: LibraryPlace = { space, share: space === 'shared' ? share : null };
  const hereLabel = libraryPlaceLabel(here, shares);
  // 요청 몸에 넣을 자리 — 공유 자료함이면 어느 것인지 함께
  const placeBody = space === 'shared' ? { space, share } : { space };

  const load = async (cursor: string | null) => {
    const seq = ++latest.current;
    setLoading(true);
    const params = new URLSearchParams();
    if (space !== 'personal') params.set('space', space);
    if (space === 'shared' && share) params.set('share', share);
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
    if (Array.isArray(r.data.shares)) { setShares(r.data.shares); onSharesChange?.(r.data.shares); }
    onCanAddChange?.(r.data.canAdd !== false);
  };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => { void load(null); }, [query, folder, refreshKey, space, share]);
  // 자리를 바꾸면 폴더 고르기를 처음으로(다른 자리의 폴더 이름은 뜻이 없다)
  useEffect(() => { setFolder(null); setNotice(null); setTransfer(null); setSelected([]); }, [space, share]);
  // 목록이 바뀌면(폴더·찾기) 고른 것을 비운다 — 보이지 않는 파일을 보내지 않게
  useEffect(() => { setSelected([]); }, [query, folder, refreshKey]);
  const spaceParam = space !== 'personal' ? `?space=${space}${space === 'shared' && share ? `&share=${encodeURIComponent(share)}` : ''}` : '';
  // 기관 자료함은 기관 전체 관리자만 담는다(서버가 다시 본다) — 못 읽었으면 막아 둔다
  const canAdd = space === 'personal' || page?.canAdd === true;

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
      const saved = await api<LibraryFile>('/api/my-library', { method: 'POST', json: { kind: 'attachment', id: staged.id, folder: target, ...placeBody } });
      if (!saved.ok) { setError(saved.error.message); return; }
      await done(`'${saved.data.file_name}'을(를) ${hereLabel} ${folderLabel(saved.data.folder)}에 담았습니다.`);
    } finally {
      void fetch(`/api/attachments/${encodeURIComponent(staged.id)}`, { method: 'DELETE' }).catch(() => {});
    }
  });

  const rename = (f: LibraryFile) => action.run(`rename:${f.id}`, async () => {
    const name = window.prompt('새 파일 이름(확장자는 그대로)', f.file_name);
    if (name === null || name.trim() === f.file_name) return;
    const r = await api<LibraryFile>(`/api/my-library/${encodeURIComponent(f.id)}`, { method: 'PATCH', json: { file_name: name, ...placeBody } });
    if (!r.ok) { setError(r.error.message); return; }
    setError(null);
    await done(`이름을 '${r.data.file_name}'(으)로 바꿨습니다.`);
  });

  const move = (f: LibraryFile) => action.run(`move:${f.id}`, async () => {
    const target = askFolder(`'${f.file_name}'을(를) 옮길 폴더`, f.folder);
    if (target === null || target === f.folder) return;
    const r = await api<LibraryFile>(`/api/my-library/${encodeURIComponent(f.id)}`, { method: 'PATCH', json: { folder: target, ...placeBody } });
    if (!r.ok) { setError(r.error.message); return; }
    setError(null);
    await done(`'${r.data.file_name}'을(를) ${folderLabel(r.data.folder)}(으)로 옮겼습니다.`);
  });

  const remove = (f: LibraryFile) => action.run(`remove:${f.id}`, async () => {
    if (!window.confirm(`'${f.file_name}'을(를) ${hereLabel}에서 지웁니다. 되돌릴 수 없습니다${space === 'organization' ? '(기관 직원 모두에게서 사라집니다' : space === 'department' ? '(부서 사람 모두에게서 사라집니다' : space === 'shared' ? '(이 공유 자료함을 쓰는 부서 사람 모두에게서 사라집니다' : '('}이 파일을 붙여 보낸 대화는 그대로입니다).`)) return;
    const r = await api<{ id: string }>(`/api/my-library/${encodeURIComponent(f.id)}${spaceParam}`, { method: 'DELETE' });
    if (!r.ok) { setError(r.error.message); return; }
    setError(null);
    await done(`'${f.file_name}'을(를) 지웠습니다.`);
  });

  // 다른 자료함으로 복사·옮기기(0296) — 복사는 볼 수 있으면, 옮기기는 이 자리에서 바꿀 수 있을 때만(서버가 다시 본다)
  const canChange = (f: LibraryFile) => (space === 'organization' ? page?.canManage === true : f.mine || page?.canManage === true);
  const targets = transferPlaces(here, page?.canAddTo, shares);
  const openTransfer = (what: TransferWhat) => {
    if (!targets.length) return;
    setError(null);
    setNotice(null);
    const files = page?.files ?? [];
    // 옮기기를 고를 수 있는가 — 서버가 파일마다 다시 본다
    const canMove = what.kind === 'file' ? canChange(what.file)
      : what.kind === 'files' ? what.ids.every((id) => { const f = files.find((x) => x.id === id); return !!f && canChange(f); })
        : space === 'personal' || page?.canManage === true;
    setTransfer({ what, to: targets[0], mode: 'copy', folder: what.kind === 'file' ? what.file.folder : '', canMove });
  };
  const toggleTransfer = (what: TransferWhat, open: boolean) => (open ? setTransfer(null) : openTransfer(what));
  const sendTransfer = () => action.run('transfer', async () => {
    if (!transfer) return;
    const { what, to, mode, folder: target } = transfer;
    const verb = mode === 'move' ? '옮겼습니다' : '복사했습니다';
    if (what.kind === 'file') {
      const r = await api<{ file: LibraryFile; warning: string | null }>(`/api/my-library/${encodeURIComponent(what.file.id)}`, {
        method: 'POST', json: { ...placeBody, to: to.space, toShare: to.share ?? undefined, mode, folder: target.trim() },
      });
      if (!r.ok) { setError(r.error.message); return; }
      setError(r.data.warning);
      setTransfer(null);
      await done(`'${what.file.file_name}'을(를) ${libraryPlaceLabel(to, shares)} ${folderLabel(r.data.file.folder)}(으)로 ${verb}.`);
      return;
    }
    // 여러 파일·폴더째(0298) — 보내기 전에 서버가 권한·상한을 한꺼번에 보고, 도중 실패한 파일은 목록으로 돌려준다
    const r = await api<BatchResult>('/api/my-library/transfer', {
      method: 'POST',
      json: { ...placeBody, to: to.space, toShare: to.share ?? undefined, mode, folder: target.trim(), ...(what.kind === 'files' ? { ids: what.ids } : { fromFolder: what.folder }) },
    });
    if (!r.ok) { setError(r.error.message); return; }
    const problems = [
      ...r.data.failed.map((x) => `'${x.file_name}': ${x.message}`),
      ...r.data.warnings,
    ];
    setError(problems.length ? `보내지 못했거나 확인할 파일 ${problems.length}개 — ${problems.slice(0, 5).join(' · ')}${problems.length > 5 ? ' …' : ''}` : null);
    setTransfer(null);
    setSelected([]);
    if (what.kind === 'folder' && mode === 'move') setFolder(null);
    await done(`${what.kind === 'folder' ? `'${folderLabel(what.folder)}' 폴더의 ` : ''}파일 ${r.data.sent}개를 ${libraryPlaceLabel(to, shares)}(으)로 ${verb}.`);
  });
  const transferForm = (t: TransferDraft, title: string) => (
    <div>
      <form aria-label={title} className="flex flex-wrap items-end gap-3 text-[14px]"
        onSubmit={(e) => { e.preventDefault(); void sendTransfer(); }}>
        <label className="flex flex-col gap-1">
          <span className="text-[13px] text-slate-500">보낼 곳</span>
          <select value={placeKey(t.to)} onChange={(e) => setTransfer({ ...t, to: placeOf(e.target.value) })} className="rounded-lg border border-[#DCE3EC] px-2 py-1.5">
            {targets.map((p) => <option key={placeKey(p)} value={placeKey(p)}>{libraryPlaceLabel(p, shares)}</option>)}
          </select>
        </label>
        <fieldset className="flex items-center gap-3">
          <legend className="sr-only">방식</legend>
          <label className="flex items-center gap-1"><input type="radio" name="transfer-mode" checked={t.mode === 'copy'} onChange={() => setTransfer({ ...t, mode: 'copy' })} /> 복사(여기에도 남김)</label>
          <label className={`flex items-center gap-1 ${t.canMove ? '' : 'text-slate-400'}`} title={t.canMove ? undefined : '옮기기는 그 파일을 바꿀 수 있는 사람만 합니다'}>
            <input type="radio" name="transfer-mode" disabled={!t.canMove} checked={t.mode === 'move'} onChange={() => setTransfer({ ...t, mode: 'move' })} /> 옮기기(여기서는 지움)
          </label>
        </fieldset>
        <label className="flex flex-col gap-1">
          <span className="text-[13px] text-slate-500">{t.what.kind === 'folder' ? '받는 폴더(그 아래에 이 폴더째 — 비우면 맨 위)' : `폴더(비우면 ${LIBRARY_UNFILED_LABEL} — / 로 ${LIBRARY_FOLDER_DEPTH}단계까지)`}</span>
          <input value={t.folder} onChange={(e) => setTransfer({ ...t, folder: e.target.value })} className="rounded-lg border border-[#DCE3EC] px-2 py-1.5" />
        </label>
        <button type="submit" disabled={busy} className="rounded-lg bg-ws-accent px-3 py-1.5 font-semibold text-white disabled:opacity-50">
          {action.running === 'transfer' ? '보내는 중…' : t.mode === 'move' ? '옮기기' : '복사하기'}
        </button>
        <button type="button" disabled={busy} onClick={() => setTransfer(null)} className="text-slate-600 underline disabled:opacity-50">취소</button>
      </form>
      {t.to.space !== 'personal' && <p className="mt-2 text-[13px] text-slate-500">{t.to.space === 'organization' ? '기관 직원 모두가' : t.to.space === 'shared' ? '그 공유 자료함을 쓰는 부서 사람이 모두' : '지금 부서 사람이 모두'} 보고 내려받게 됩니다.</p>}
    </div>
  );
  const shownIds = (page?.files ?? []).map((f) => f.id);
  const allSelected = shownIds.length > 0 && shownIds.every((id) => selected.includes(id));

  // 폴더째 이름 바꾸기·옮기기(0294) — 고른 폴더와 그 아래를 새 경로로. 부서 자료함은 관리자, 기관 자료함은 기관 전체 관리자(canManage)
  const moveFolder = (from: string) => action.run(`folder:${from}`, async () => {
    const to = askFolder(`'${folderLabel(from)}' 폴더(와 그 아래 폴더)를 옮길 새 경로`, from);
    if (to === null || to === from) return;
    const r = await api<{ moved: number; folders: number }>('/api/my-library/folders', { method: 'PATCH', json: { ...placeBody, from, to } });
    if (!r.ok) { setError(r.error.message); return; }
    setError(null);
    setFolder(null);
    await done(`'${folderLabel(from)}'을(를) '${folderLabel(to)}'(으)로 옮겼습니다(파일 ${r.data.moved}개).`);
  });

  // 폴더 나무(0113) — 윗단계 폴더도 보이고 수는 그 아래까지 합친다. 고르면 그 아래 폴더의 파일도 함께 보인다
  const folders = folderTree(page?.folders ?? []);
  const busy = action.running !== null;
  return (
    <section aria-label="자료함" className="mt-8">
      <div role="tablist" aria-label="자료함 고르기" className="mb-3 flex gap-2">
        {LIBRARY_SPACES.map((s) => (
          <button key={s} type="button" role="tab" aria-selected={space === s} onClick={() => onSpaceChange(s)}
            className={`rounded-lg px-3 py-1.5 text-[15px] font-semibold ${space === s ? 'bg-ws-accent/10 text-ws-accent-text' : 'text-slate-500 hover:text-slate-800'}`}>{libraryPlaceLabel({ space: s })}</button>
        ))}
        {/* 내가 든 공유 자료함(0116) — 지금 소속 부서가 든 것만 */}
        {shares.map((s) => (
          <button key={s.id} type="button" role="tab" aria-selected={space === 'shared' && share === s.id} onClick={() => onSpaceChange('shared', s.id)}
            className={`rounded-lg px-3 py-1.5 text-[15px] font-semibold ${space === 'shared' && share === s.id ? 'bg-ws-accent/10 text-ws-accent-text' : 'text-slate-500 hover:text-slate-800'}`}>{s.name}</button>
        ))}
      </div>
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h2 className="text-[17px] font-semibold text-slate-900">{hereLabel}</h2>
          <p className="mt-1 text-[13px] text-slate-500">{SPACE_NOTE[space]}</p>
        </div>
        {canAdd && <label className={`rounded-lg border border-[#DCE3EC] px-3 py-1.5 text-[14px] ${busy ? 'opacity-50' : 'cursor-pointer hover:border-[#003087]'}`}>
          {action.running === 'upload' ? '올리는 중…' : '파일 올려 담기'}
          <input type="file" aria-label={`${hereLabel}에 파일 올리기`} accept={ATTACHMENT_ACCEPT} disabled={busy} className="sr-only"
            onChange={(e) => { const file = e.target.files?.[0]; e.target.value = ''; if (file) void upload(file); }} />
        </label>}
      </div>
      {page && <p className="mt-2 text-[13px] text-slate-500">{page.total} / {page.limit}개</p>}
      <div role="group" aria-label="폴더" className="mt-3 mb-3 flex flex-wrap gap-2">
        <button type="button" aria-pressed={folder === null} onClick={() => setFolder(null)}
          className={`rounded-full border px-3 py-1 text-[13px] ${folder === null ? 'border-ws-accent bg-ws-accent/10 text-ws-accent-text' : 'border-[#DCE3EC] text-slate-600'}`}>전체</button>
        {folders.map((f) => (
          <button key={f.path || '__unfiled'} type="button" aria-pressed={folder === f.path} onClick={() => setFolder(f.path)} title={folderLabel(f.path)}
            className={`rounded-full border px-3 py-1 text-[13px] ${folder === f.path ? 'border-ws-accent bg-ws-accent/10 text-ws-accent-text' : 'border-[#DCE3EC] text-slate-600'}`}>
            {folderLabel(f.path)} <span className="text-slate-400">{f.count}</span>
          </button>
        ))}
      </div>
      {folder && (space === 'personal' || page?.canManage) && (
        <button type="button" disabled={busy} onClick={() => void moveFolder(folder)} className="mb-3 text-[13px] text-slate-600 underline disabled:opacity-50">
          {action.running === `folder:${folder}` ? '옮기는 중…' : `'${folderLabel(folder)}' 폴더 이름 바꾸기·옮기기`}
        </button>
      )}
      {folder && targets.length > 0 && (
        <button type="button" disabled={busy} aria-expanded={transfer?.what.kind === 'folder'}
          onClick={() => toggleTransfer({ kind: 'folder', folder }, transfer?.what.kind === 'folder')}
          className="mb-3 ml-3 text-[13px] text-slate-600 underline disabled:opacity-50">{`'${folderLabel(folder)}' 폴더째 다른 자료함으로`}</button>
      )}
      {selected.length > 0 && targets.length > 0 && (
        <div className="mb-3 flex flex-wrap items-center gap-3 text-[14px]">
          <span className="text-slate-600">{selected.length}개 고름</span>
          <button type="button" disabled={busy} aria-expanded={transfer?.what.kind === 'files'}
            onClick={() => toggleTransfer({ kind: 'files', ids: selected, names: (page?.files ?? []).filter((f) => selected.includes(f.id)).map((f) => f.file_name) }, transfer?.what.kind === 'files')}
            className="text-slate-600 underline disabled:opacity-50">고른 파일 다른 자료함으로</button>
          <button type="button" disabled={busy} onClick={() => setSelected([])} className="text-slate-500 underline disabled:opacity-50">고르기 풀기</button>
        </div>
      )}
      {transfer && transfer.what.kind !== 'file' && (
        <div className="mb-3 rounded-lg border border-[#DCE3EC] bg-slate-50 px-4 py-3">
          {transferForm(transfer, transfer.what.kind === 'folder' ? `'${folderLabel(transfer.what.folder)}' 폴더째 다른 자료함으로` : `고른 파일 ${transfer.what.ids.length}개를 다른 자료함으로`)}
        </div>
      )}
      <ErrorNote message={error} />
      {notice && <p role="status" className="mb-3 text-[13px] text-ws-accent-text">{notice}</p>}
      {query && <p className="mb-2 text-[13px] text-slate-500">{LIBRARY_CONTENT_SEARCH_NOTE}</p>}
      <Card className="p-0 overflow-x-auto">
        {(unread && !page) || (page && page.files.length === 0) ? (
          <div className="p-6 text-[15px] text-slate-600">
            {unread && !page ? emptyListText(true, '', `${hereLabel}을`) : query ? `'${query}'이(가) 이름이나 내용에 든 파일이 없습니다.` : folder !== null ? '이 폴더(와 그 아래 폴더)에 담은 파일이 없습니다.' : canAdd ? `아직 담은 파일이 없습니다. 위 ‘파일 올려 담기’나 아래 목록의 ‘${hereLabel}에 담기’로 담으세요.` : '아직 기관 전체 관리자가 담은 파일이 없습니다.'}
          </div>
        ) : (
          <table className="w-full min-w-[720px] text-left text-[15px]">
            <thead className="border-b border-[#DCE3EC] text-[13px] text-slate-500">
              <tr>
                {targets.length > 0 && (
                  <th scope="col" className="w-10 pl-5 py-3 font-medium">
                    <input type="checkbox" aria-label="이 목록의 파일 모두 고르기" checked={allSelected} disabled={busy}
                      onChange={(e) => setSelected(e.target.checked ? shownIds : [])} />
                  </th>
                )}
                <th scope="col" className="px-5 py-3 font-medium">파일</th>
                <th scope="col" className="px-5 py-3 font-medium">폴더</th>
                <th scope="col" className="px-5 py-3 font-medium">{isSharedLibrarySpace(space) ? '담은 사람' : '담은 곳'}</th>
                <th scope="col" className="px-5 py-3 font-medium">담은 때</th>
                <th scope="col" className="px-5 py-3 font-medium"><span className="sr-only">조작</span></th>
              </tr>
            </thead>
            <tbody>
              {(page?.files ?? []).map((f) => (
                <Fragment key={f.id}>
                <tr className="border-b border-[#DCE3EC] last:border-0">
                  {targets.length > 0 && (
                    <td className="w-10 pl-5 py-3">
                      <input type="checkbox" aria-label={`'${f.file_name}' 고르기`} checked={selected.includes(f.id)} disabled={busy}
                        onChange={(e) => setSelected(e.target.checked ? [...selected, f.id] : selected.filter((id) => id !== f.id))} />
                    </td>
                  )}
                  <td className="px-5 py-3">
                    <span className="mr-2 rounded border border-[#DCE3EC] px-1.5 py-0.5 text-[12px] font-semibold">{fileBadge(f.file_name)}</span>
                    {f.file_name} <span className="text-[13px] text-slate-500">{formatBytes(f.size_bytes)}</span>
                    {f.snippet && (
                      <p className="mt-1 max-w-[36rem] text-[13px] leading-5 text-slate-500">
                        <span className="sr-only">내용에서 찾음: </span>{f.snippet.before}<mark className="rounded bg-amber-100 px-0.5 text-slate-800">{f.snippet.hit}</mark>{f.snippet.after}
                      </p>
                    )}
                  </td>
                  <td className="px-5 py-3 text-slate-600">{folderLabel(f.folder)}</td>
                  <td className="px-5 py-3 text-slate-600">{isSharedLibrarySpace(space) ? (f.mine ? '나' : f.added_by ?? '—') : LIBRARY_SOURCE_LABEL[f.source]}</td>
                  <td className="px-5 py-3 text-[14px] text-slate-500">{formatDateTime(f.created_at)}</td>
                  <td className="whitespace-nowrap px-5 py-3 text-right text-[14px]">
                    <a href={`/api/my-library/${encodeURIComponent(f.id)}/original`} className="rounded-lg border border-[#DCE3EC] px-3 py-1.5 hover:border-[#003087]">내려받기</a>
                    {targets.length > 0 && (
                      <button type="button" disabled={busy} aria-expanded={transfer?.what.kind === 'file' && transfer.what.file.id === f.id}
                        onClick={() => toggleTransfer({ kind: 'file', file: f }, transfer?.what.kind === 'file' && transfer.what.file.id === f.id)}
                        className="ml-2 text-slate-600 underline disabled:opacity-50">다른 자료함으로</button>
                    )}
                    {/* 부서 자료함에서 남이 담은 파일은 관리자만, 기관 자료함은 기관 전체 관리자만 바꾼다(서버가 다시 본다) */}
                    {canChange(f) && <>
                      <button type="button" disabled={busy} onClick={() => void rename(f)} className="ml-2 text-slate-600 underline disabled:opacity-50">이름</button>
                      <button type="button" disabled={busy} onClick={() => void move(f)} className="ml-2 text-slate-600 underline disabled:opacity-50">옮기기</button>
                      <button type="button" disabled={busy} onClick={() => void remove(f)} className="ml-2 text-red-600 underline disabled:opacity-50">지우기</button>
                    </>}
                  </td>
                </tr>
                {transfer?.what.kind === 'file' && transfer.what.file.id === f.id && (
                  <tr className="border-b border-[#DCE3EC] bg-slate-50">
                    <td colSpan={targets.length > 0 ? 6 : 5} className="px-5 py-3">
                      {transferForm(transfer, `'${f.file_name}'을(를) 다른 자료함으로`)}
                    </td>
                  </tr>
                )}
                </Fragment>
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
