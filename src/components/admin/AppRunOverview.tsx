'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { requestJson, serverErrorText } from '@/lib/ok-json';
import { latestGate } from '@/lib/latest-request';
import type { AppRunOverview as Overview } from '@/lib/apps/run-overview';

const kst = (iso: string) => new Date(new Date(iso).getTime() + 9 * 60 * 60 * 1000).toISOString().slice(0, 16).replace('T', ' ');

/** 관리자용 입력형 앱 실행 현황 — 상태만, 입력·결과·실행한 사람 없음 */
export function AppRunOverviewTable({ data }: { data: Overview }) {
  const { apps, personal } = data;
  if (!apps.length && !personal.runs && !personal.apps) {
    return <p className="text-sm text-slate-500">관리 범위에 입력형 앱이 없습니다.</p>;
  }
  return (
    <div className="space-y-3">
      <div className="overflow-x-auto rounded-xl border border-slate-200 bg-white">
        <table className="min-w-full text-sm">
          <thead className="bg-slate-50 text-left text-xs text-slate-500">
            <tr>
              <th className="px-3 py-2">앱</th>
              <th className="px-3 py-2">부서</th>
              <th className="px-3 py-2 text-right">실행</th>
              <th className="px-3 py-2 text-right">완료</th>
              <th className="px-3 py-2 text-right">중단</th>
              <th className="px-3 py-2 text-right">확인 필요·응답 없음</th>
              <th className="px-3 py-2">자주 멈춘 단계</th>
              <th className="px-3 py-2">마지막 중단</th>
            </tr>
          </thead>
          <tbody>
            {apps.map((app) => (
              <tr key={app.agentId} className="border-t border-slate-100">
                <td className="px-3 py-2 font-medium text-slate-900">{app.name}</td>
                <td className="px-3 py-2 text-slate-600">{app.departmentName ?? '—'}</td>
                <td className="px-3 py-2 text-right tabular-nums">{app.runs.toLocaleString('ko-KR')}</td>
                <td className="px-3 py-2 text-right tabular-nums">{app.saved.toLocaleString('ko-KR')}</td>
                <td className={`px-3 py-2 text-right tabular-nums ${app.interrupted ? 'font-semibold text-red-700' : ''}`}>{app.interrupted.toLocaleString('ko-KR')}</td>
                <td className="px-3 py-2 text-right tabular-nums">{(app.uncertain + app.noResponse).toLocaleString('ko-KR')}</td>
                <td className="px-3 py-2 text-slate-600">{app.failedSteps.length ? app.failedSteps.map((s) => `${s.name}(${s.count})`).join(', ') : '—'}</td>
                <td className="px-3 py-2 text-slate-600">{app.lastInterruptedAt ? kst(app.lastInterruptedAt) : '—'}</td>
              </tr>
            ))}
            {personal.apps > 0 && (
              <tr className="border-t border-slate-100 bg-slate-50/60">
                <td className="px-3 py-2 text-slate-700">개인 앱 {personal.apps.toLocaleString('ko-KR')}개(이름 비공개)</td>
                <td className="px-3 py-2 text-slate-600">—</td>
                <td className="px-3 py-2 text-right tabular-nums">{personal.runs.toLocaleString('ko-KR')}</td>
                <td className="px-3 py-2 text-right tabular-nums">{personal.saved.toLocaleString('ko-KR')}</td>
                <td className="px-3 py-2 text-right tabular-nums">{personal.interrupted.toLocaleString('ko-KR')}</td>
                <td className="px-3 py-2 text-right tabular-nums">{(personal.uncertain + personal.noResponse).toLocaleString('ko-KR')}</td>
                <td className="px-3 py-2 text-slate-600">—</td>
                <td className="px-3 py-2 text-slate-600">—</td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
      {data.truncated && <p className="text-xs text-amber-700">실행이 많아 최근 실행만 셌습니다.</p>}
    </div>
  );
}

export const APP_RUN_OVERVIEW_UNREAD = '앱 실행 현황을 불러오지 못했습니다.';

/** 기간(2026-11-26) — 비우면 최근 30일. 고른 기간을 다시 읽는 동안 앞 표를 지우고, 늦게 온 앞 응답은 버린다 */
export default function AppRunOverview() {
  const [data, setData] = useState<Overview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [csvError, setCsvError] = useState<string | null>(null);
  const gate = useRef(latestGate());
  const query = (f: string, t: string) => {
    const q = new URLSearchParams();
    if (f) q.set('from', f);
    if (t) q.set('to', t);
    return q;
  };
  const load = useCallback(async (f: string, t: string) => {
    const ticket = gate.current.begin();
    setData(null); setError(null);
    const r = await requestJson(`/api/admin/app-overview?${query(f, t)}`);
    if (!gate.current.isLatest(ticket)) return;
    if (!r.ok) setError(serverErrorText(r.body, APP_RUN_OVERVIEW_UNREAD));
    else setData((r.body as { data: Overview }).data);
  }, []);
  useEffect(() => { void load('', ''); }, [load]);
  async function downloadCsv() {
    setCsvError(null);
    const q = query(from, to);
    q.set('format', 'csv');
    try {
      const res = await fetch(`/api/admin/app-overview?${q}`);
      if (!res.ok) { setCsvError(serverErrorText(await res.json().catch(() => null), 'CSV를 만들지 못했습니다.')); return; }
      const url = URL.createObjectURL(await res.blob());
      const a = document.createElement('a');
      a.href = url;
      a.download = `앱 실행 현황 ${data?.from ?? ''}~${data?.to ?? ''}.csv`;
      a.click();
      URL.revokeObjectURL(url);
    } catch { setCsvError('CSV를 만들지 못했습니다.'); }
  }
  return (
    <div className="space-y-3">
      <form className="flex flex-wrap items-end gap-2 text-xs" onSubmit={(e) => { e.preventDefault(); void load(from, to); }}>
        <label className="flex flex-col gap-1 text-slate-600">시작일<input type="date" aria-label="실행 현황 시작일" value={from} onChange={(e) => setFrom(e.target.value)} className="rounded border border-slate-300 px-2 py-1" /></label>
        <label className="flex flex-col gap-1 text-slate-600">끝 날<input type="date" aria-label="실행 현황 끝 날" value={to} onChange={(e) => setTo(e.target.value)} className="rounded border border-slate-300 px-2 py-1" /></label>
        <button type="submit" className="rounded bg-slate-800 px-3 py-1.5 font-semibold text-white">조회</button>
        <button type="button" disabled={!data} onClick={() => void downloadCsv()} className="rounded border border-slate-300 px-3 py-1.5 text-slate-700 disabled:opacity-40">CSV 내려받기</button>
        <span className="text-slate-500">{data?.from && data?.to ? `${data.from} ~ ${data.to}(한국 날짜, 끝 날 포함)` : '비우면 최근 30일 · 1년까지'}</span>
      </form>
      {csvError && <p role="alert" className="text-sm text-red-700">{csvError}</p>}
      {error ? <p role="alert" className="text-sm text-red-700">{error}</p>
        : !data ? <p role="status" className="text-sm text-slate-500">불러오는 중…</p>
        : <AppRunOverviewTable data={data} />}
    </div>
  );
}
