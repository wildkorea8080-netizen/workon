'use client';

import { useEffect, useState } from 'react';
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

export default function AppRunOverview() {
  const [data, setData] = useState<Overview | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let active = true;
    fetch('/api/admin/app-overview')
      .then(async (res) => {
        const body = await res.json().catch(() => null);
        if (!active) return;
        if (!res.ok || !body?.ok) setError(body?.error?.message ?? '앱 실행 현황을 불러오지 못했습니다.');
        else setData(body.data as Overview);
      })
      .catch(() => { if (active) setError('앱 실행 현황을 불러오지 못했습니다.'); });
    return () => { active = false; };
  }, []);
  if (error) return <p role="alert" className="text-sm text-red-700">{error}</p>;
  if (!data) return <p role="status" className="text-sm text-slate-500">불러오는 중…</p>;
  return <AppRunOverviewTable data={data} />;
}
