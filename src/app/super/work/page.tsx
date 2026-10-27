'use client';

import { useCallback, useEffect, useState } from 'react';

/**
 * 슈퍼관리자 — 기관별 업무 화면 전환(06 문서 M3·M5). 대표 기관부터 켠다.
 * 업무 홈을 끄면 그 기관 직원 홈은 대화 화면으로 돌아가고, 새 작업을 끄면 새 작업·실행이 막힌다. 이미 만든 작업·파일은 남는다.
 */
interface Row { id: string; name: string; status: string; homeEnabled: boolean; newTasksEnabled: boolean; updatedAt: string | null }

export default function SuperWorkPage() {
  const [rows, setRows] = useState<Row[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const load = useCallback(async () => {
    const res = await fetch('/api/super/work-settings');
    const body = await res.json().catch(() => null);
    if (!body?.ok) return setError(body?.error?.message ?? '목록을 불러오지 못했습니다.');
    setRows(body.data);
  }, []);
  useEffect(() => {
    void load();
  }, [load]);

  async function save(r: Row, patch: Partial<Pick<Row, 'homeEnabled' | 'newTasksEnabled'>>) {
    setBusy(r.id);
    setError(null);
    const next = { homeEnabled: patch.homeEnabled ?? r.homeEnabled, newTasksEnabled: patch.newTasksEnabled ?? r.newTasksEnabled };
    const res = await fetch('/api/super/work-settings', { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ organizationId: r.id, ...next }) });
    const body = await res.json().catch(() => null);
    setBusy(null);
    if (!body?.ok) return setError(body?.error?.message ?? '바꾸지 못했습니다.');
    await load();
  }

  return (
    <div className="space-y-4 p-6">
      <div>
        <h1 className="text-2xl font-bold text-gray-900">업무 화면 전환</h1>
        <p className="mt-1 text-sm text-gray-600">
          기관마다 업무 홈과 새 작업을 켭니다. 대표 기관 하나부터 켜고 확인한 뒤 넓히세요. 끄면 새 작업만 막히고, 이미 만든 작업·파일은 읽기·내려받기가 남습니다. 바꾼 기록은 슈퍼관리자 로그에 남습니다.
        </p>
      </div>
      {error && <p role="alert" className="rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-800">{error}</p>}
      <table className="w-full rounded-xl border border-gray-200 bg-white text-sm">
        <thead>
          <tr className="border-b text-left text-gray-600">
            <th scope="col" className="px-3 py-2">기관</th>
            <th scope="col" className="px-3 py-2">상태</th>
            <th scope="col" className="px-3 py-2">업무 홈</th>
            <th scope="col" className="px-3 py-2">새 작업</th>
            <th scope="col" className="px-3 py-2">바꾼 때</th>
          </tr>
        </thead>
        <tbody>
          {rows?.map((r) => (
            <tr key={r.id} className="border-b border-gray-50">
              <td className="px-3 py-2">{r.name}</td>
              <td className="px-3 py-2 text-gray-600">{r.status}</td>
              <td className="px-3 py-2">
                <label className="flex items-center gap-2">
                  <input type="checkbox" checked={r.homeEnabled} disabled={busy === r.id} onChange={(e) => save(r, { homeEnabled: e.target.checked })} aria-label={`${r.name} 업무 홈`} />
                  {r.homeEnabled ? '켬' : '끔'}
                </label>
              </td>
              <td className="px-3 py-2">
                <label className="flex items-center gap-2">
                  <input type="checkbox" checked={r.newTasksEnabled} disabled={busy === r.id} onChange={(e) => save(r, { newTasksEnabled: e.target.checked })} aria-label={`${r.name} 새 작업`} />
                  {r.newTasksEnabled ? '켬' : '끔'}
                </label>
              </td>
              <td className="px-3 py-2 text-gray-500">{r.updatedAt ? new Date(r.updatedAt).toLocaleString('ko-KR') : '—'}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
