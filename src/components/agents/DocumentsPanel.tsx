'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { uploadReferenceDocument, startReading } from '@/lib/document-upload-client';
import { kstDay } from '@/lib/kst-time';
import type { Document } from '@/lib/db';

/**
 * 비서 편집 창의 '문서' 탭(2026-11-06) — 이 비서가 근거로 쓰는 참고 문서를 주인(고칠 수 있는 사람)이 직접 본다.
 * 예전에는 나만의 비서·부서 비서를 만들며 올린 문서가 읽혔는지 볼 곳이 없었다(관리자 문서 화면에는 부서 공개 문서가 안 보일 수 있다).
 *
 * - 목록은 `GET /api/documents?agent_id=`(보이는 범위는 서버가 그대로 건다)
 * - 다시 시도는 읽기 라우트(`canEditAgent`), 지우기는 문서 삭제 라우트(`canDeleteAgent`) — 권한은 서버가 다시 본다
 * - 읽는 중인 문서가 있는 동안만 앞 응답 뒤 5초마다 다시 부르고, 늦은 옛 응답은 버린다(관리자 문서 화면과 같은 규칙)
 * - 오래 멈춘 행(`kick`)은 이 화면에서 한 번만 다시 건다
 */
type Row = Document & { kick?: boolean };

const POLL_INTERVAL_MS = 5_000;

export function documentStatusLabel(doc: Pick<Row, 'noda_status' | 'noda_reason'>): { text: string; tone: 'ok' | 'busy' | 'bad' | 'muted' } {
  switch (doc.noda_status) {
    case 'ready':
      return { text: '읽음 — 대화에서 근거로 씀', tone: 'ok' };
    case 'reading':
      return { text: '읽는 중', tone: 'busy' };
    case 'failed':
      return { text: `읽기 실패${doc.noda_reason ? ` — ${doc.noda_reason}` : ''}`, tone: 'bad' };
    case 'unreadable':
      return { text: `읽지 못함${doc.noda_reason ? ` — ${doc.noda_reason}` : ''}`, tone: 'bad' };
    case 'deleting':
      return { text: '지우는 중 — 다시 지워 주세요', tone: 'bad' };
    case 'retired':
      return { text: '지난 판 — 근거로 쓰지 않음', tone: 'muted' };
    default:
      return { text: '옮기기 전 문서 — 관리자에게 문의', tone: 'muted' };
  }
}

const TONE: Record<string, string> = {
  ok: 'bg-emerald-50 text-emerald-800',
  busy: 'bg-blue-50 text-blue-800',
  bad: 'bg-red-50 text-red-700',
  muted: 'bg-slate-100 text-slate-600',
};

export default function DocumentsPanel({ agentId, docSearchOn }: { agentId: string; docSearchOn: boolean }) {
  const [rows, setRows] = useState<Row[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);
  const seqRef = useRef(0);
  const kickedRef = useRef<Set<string>>(new Set());

  const refresh = useCallback(async () => {
    const seq = ++seqRef.current;
    try {
      const body = await (await fetch(`/api/documents?agent_id=${encodeURIComponent(agentId)}`)).json();
      if (seq !== seqRef.current) return;
      if (!body?.ok) {
        setError(body?.error?.message ?? '문서를 불러오지 못했습니다.');
        return;
      }
      const list = body.data as Row[];
      setRows(list);
      for (const r of list) {
        if (r.kick && !kickedRef.current.has(r.id)) {
          kickedRef.current.add(r.id);
          startReading([r.id]);
        }
      }
    } catch {
      if (seq === seqRef.current) setError('문서를 불러오지 못했습니다.');
    }
  }, [agentId]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const hasReading = (rows ?? []).some((r) => r.noda_status === 'reading');
  useEffect(() => {
    if (!hasReading) return;
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const tick = async () => {
      await refresh();
      if (!stopped) timer = setTimeout(tick, POLL_INTERVAL_MS);
    };
    timer = setTimeout(tick, POLL_INTERVAL_MS);
    return () => {
      stopped = true;
      if (timer) clearTimeout(timer);
    };
  }, [hasReading, refresh]);

  const upload = async () => {
    const files = Array.from(fileRef.current?.files ?? []);
    if (!files.length) {
      setError('올릴 파일을 골라 주세요.');
      return;
    }
    setBusy(true);
    setError(null);
    setNotice(null);
    const failed: string[] = [];
    const ids: string[] = [];
    for (const file of files) {
      const result = await uploadReferenceDocument(file, { agentIds: [agentId] });
      if (result.ok) ids.push(...result.documentIds);
      else failed.push(`${file.name}: ${result.message}`);
    }
    if (ids.length) startReading(ids);
    if (fileRef.current) fileRef.current.value = '';
    if (failed.length) setError(`올리지 못한 파일이 있습니다 — ${failed.join(' / ')}`);
    if (ids.length) setNotice('문서를 올렸습니다. 읽는 중입니다 — 다 읽으면 비서가 근거로 찾습니다.');
    setBusy(false);
    await refresh();
  };

  const retry = (id: string) => {
    startReading([id], { retry: true });
    // 이미 나간 목록 요청의 '읽기 실패'가 아래 표시를 덮지 않게 버리고, 먼저 읽는 중으로 보인다
    seqRef.current++;
    setRows((prev) => (prev ?? []).map((r) => (r.id === id ? { ...r, noda_status: 'reading', noda_reason: null } : r)));
  };

  const remove = async (doc: Row) => {
    if (!confirm(`'${doc.title || doc.file_name}' 문서를 지울까요? 되돌릴 수 없습니다.`)) return;
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const res = await fetch('/api/documents', {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ documentId: doc.id }),
      });
      const body = await res.json().catch(() => null);
      if (!body?.ok) setError(body?.error?.message ?? '문서를 지우지 못했습니다.');
      else setNotice('문서를 지웠습니다.');
    } catch {
      setError('문서를 지우지 못했습니다.');
    } finally {
      setBusy(false);
      await refresh();
    }
  };

  const current = (rows ?? []).filter((r) => r.noda_status !== 'retired');
  const retiredCount = (rows ?? []).length - current.length;

  return (
    <div className="space-y-4">
      <p className="text-xs text-slate-500">
        비서가 늘 근거로 삼는 참고 문서입니다. 올리면 문서 읽기 서비스가 읽고, &lsquo;읽음&rsquo;이 된 문서부터 대화에서 근거로 찾습니다.
      </p>
      {!docSearchOn && (
        <p className="rounded-xl border border-amber-200 bg-amber-50 p-3 text-xs text-amber-800">
          &lsquo;참고 문서 찾기&rsquo;가 꺼져 있어 지금은 대화에서 이 문서들을 쓰지 않습니다. 설정 탭에서 켜고 저장하세요.
        </p>
      )}

      {rows === null && !error && <p className="text-sm text-slate-400">불러오는 중...</p>}

      <ul className="space-y-2">
        {current.map((doc) => {
          const status = documentStatusLabel(doc);
          return (
            <li key={doc.id} className="flex items-start gap-3 rounded-xl border border-slate-100 p-3">
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm font-medium text-slate-800">{doc.title || doc.file_name}</p>
                <p className="mt-0.5 text-[11px] text-slate-400">
                  {doc.file_name} · 올린 날 {kstDay(doc.created_at)}
                </p>
                <span className={`mt-1 inline-block rounded px-2 py-0.5 text-[11px] font-medium ${TONE[status.tone]}`}>{status.text}</span>
              </div>
              <div className="flex flex-shrink-0 gap-1.5">
                {doc.noda_status === 'failed' && (
                  <button
                    type="button"
                    onClick={() => retry(doc.id)}
                    disabled={busy}
                    className="rounded-lg border border-slate-200 px-3 py-1 text-xs text-slate-600 hover:bg-slate-50 disabled:opacity-50"
                  >
                    다시 시도
                  </button>
                )}
                <button
                  type="button"
                  onClick={() => void remove(doc)}
                  disabled={busy}
                  className="rounded-lg border border-red-200 px-3 py-1 text-xs text-red-500 hover:bg-red-50 disabled:opacity-50"
                >
                  지우기
                </button>
              </div>
            </li>
          );
        })}
        {rows !== null && current.length === 0 && <li className="py-4 text-center text-xs text-slate-400">올린 참고 문서가 없습니다.</li>}
      </ul>
      {retiredCount > 0 && <p className="text-[11px] text-slate-400">지난 판 {retiredCount}개는 근거로 쓰지 않습니다(관리자 문서 화면에서 볼 수 있음).</p>}

      <div className="space-y-2 rounded-xl border border-slate-200 p-3">
        <input ref={fileRef} type="file" multiple aria-label="올릴 참고 문서" className="block w-full text-xs text-slate-500" />
        <button
          type="button"
          onClick={() => void upload()}
          disabled={busy}
          className="rounded-xl bg-[#003087] px-4 py-2 text-sm font-semibold text-white hover:bg-[#002070] disabled:bg-slate-300"
        >
          {busy ? '처리 중...' : '참고 문서 올리기'}
        </button>
      </div>

      {error && <p role="alert" className="text-xs text-red-500">{error}</p>}
      {notice && <p className="text-xs text-green-600">{notice}</p>}
    </div>
  );
}
