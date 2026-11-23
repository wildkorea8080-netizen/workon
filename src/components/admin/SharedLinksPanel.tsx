'use client';

import { useCallback, useEffect, useState } from 'react';
import { actionErrorText, emptyListText } from '@/lib/ok-json';

/**
 * 관리 범위 직원이 **공개 링크로 공유 중인 대화**(2026-11-18).
 * 로그인 없이 열리는 링크라 기관이 알고 멈출 수 있어야 한다. 누가·언제 공유했는지만 보인다 — 대화 제목·내용·링크 주소는 받지 않는다.
 */
interface SharedRow {
  id: string;
  userName: string | null;
  departmentName: string | null;
  sharedAt: string | null;
}

function kstDateTime(iso: string | null): string {
  if (!iso) return '(이전 방식 — 대화 전체가 보임)';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '(알 수 없음)';
  return d.toLocaleString('ko-KR', { timeZone: 'Asia/Seoul', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
}

export default function SharedLinksPanel() {
  const [rows, setRows] = useState<SharedRow[] | null>(null);
  const [truncated, setTruncated] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // 목록을 못 읽은 것은 조작 오류(error)와 따로 — 읽기가 '공유 중단' 실패 글을 지우거나 덮지 않게(2026-11-22)
  const [unread, setUnread] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const res = await fetch('/api/admin/shared-conversations');
      const result = await res.json().catch(() => null);
      if (!res.ok || !result?.ok || !Array.isArray(result.data)) throw new Error('unread');
      setRows(result.data);
      setTruncated(result.truncated === true);
      setUnread(false);
    } catch {
      // 실패를 '공유 중인 대화 없음'으로 보이지 않고, 앞 목록(이미 멈춘 링크가 남았을 수 있음)도 버린다
      setRows(null);
      setTruncated(false);
      setUnread(true);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const stop = async (row: SharedRow) => {
    const reason = prompt(
      `${row.userName ?? '이 직원'}의 공개 링크를 중단합니다. 링크 주소가 버려져 되살릴 수 없고, 보안 로그에 남습니다.\n중단 사유를 5자 이상 적어 주세요.`,
    );
    if (reason === null) return;
    setBusyId(row.id);
    setError(null);
    setNotice(null);
    try {
      const res = await fetch(`/api/admin/shared-conversations/${row.id}`, {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ reason }),
      });
      const result = await res.json();
      if (!result.ok) throw new Error(result.error?.message || '공유를 중단하지 못했습니다.');
      setNotice('공개 링크를 중단했습니다.');
    } catch (err) {
      setError(actionErrorText(err, '공유를 중단하지 못했습니다.'));
    } finally {
      setBusyId(null);
      await load();
    }
  };

  return (
    <div className="space-y-4">
      <div>
        <h2 className="text-xl font-semibold">공개 링크로 공유 중인 대화</h2>
        <p className="text-slate-600 mt-1">
          직원이 대화를 로그인 없이 볼 수 있는 링크로 공유한 것입니다(링크에는 공유한 때까지의 대화만 보입니다).
          누가 언제 공유했는지만 보이고, 대화 내용과 링크 주소는 여기서 보이지 않습니다.
        </p>
      </div>

      {error && <div className="p-4 text-red-700 bg-red-100 rounded-lg">{error}</div>}
      {notice && <div className="p-4 text-emerald-800 bg-emerald-50 rounded-lg">{notice}</div>}

      <div className="p-6 border rounded-lg bg-white">
        {rows === null && !unread && <p className="text-sm text-slate-500">불러오는 중...</p>}
        {unread && <p role="alert" className="text-sm text-red-700">{emptyListText(true, '', '공유 중인 대화를')}</p>}
        {rows !== null && rows.length === 0 && <p className="text-sm text-slate-500">공유 중인 대화가 없습니다.</p>}
        {rows !== null && rows.length > 0 && (
          <ul className="divide-y divide-slate-100">
            {rows.map((row) => (
              <li key={row.id} className="flex items-center justify-between gap-3 py-3 text-sm">
                <div>
                  <p className="font-medium text-slate-900">{row.userName ?? '(이름을 확인하지 못함)'}</p>
                  <p className="text-xs text-slate-500">
                    {row.departmentName ?? '(부서 모름)'} · 공유한 때: {kstDateTime(row.sharedAt)}
                  </p>
                </div>
                <button
                  type="button"
                  onClick={() => stop(row)}
                  disabled={busyId === row.id}
                  className="px-3 py-1.5 text-xs border border-red-200 text-red-600 rounded-lg hover:bg-red-50 disabled:opacity-50"
                >
                  {busyId === row.id ? '중단하는 중...' : '공유 중단'}
                </button>
              </li>
            ))}
          </ul>
        )}
        {truncated && <p className="mt-3 text-xs text-amber-700">최근 200건만 보입니다.</p>}
      </div>
    </div>
  );
}
