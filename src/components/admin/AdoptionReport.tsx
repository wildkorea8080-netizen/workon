'use client';

import { useEffect, useState } from 'react';
import { adoptionCsv, formatAdoptionChange, formatAdoptionValue, recentMonths, type AdoptionRow } from '@/lib/adoption-report';

type Report = { month: string; previous: string; departments: number; partial: boolean; rows: AdoptionRow[] };

/**
 * 월별 도입 현황 보고서(0056) — 관리자 통계 화면. 한 달(한국 시간)의 채택·사용·업무 작업·비용 숫자를 전월과 나란히 보이고 CSV로 내려받는다.
 * 기록된 사실만 센다. 절약한 시간 같은 추정치는 싣지 않는다
 */
export default function AdoptionReport() {
  const months = recentMonths(Date.now());
  const [month, setMonth] = useState(months[0]);
  const [report, setReport] = useState<Report | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    setLoading(true); setError(null);
    fetch(`/api/admin/adoption-report?month=${encodeURIComponent(month)}`)
      .then((r) => r.json())
      .then((body) => { if (!active) return; if (body?.ok) setReport(body.data as Report); else { setReport(null); setError(body?.error?.message ?? '도입 현황을 불러오지 못했습니다.'); } })
      .catch(() => { if (active) setError('네트워크 오류가 발생했습니다.'); })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [month]);

  function download() {
    if (!report) return;
    const url = URL.createObjectURL(new Blob([adoptionCsv(report.month, report.previous, report.rows)], { type: 'text/csv;charset=utf-8' }));
    const a = document.createElement('a'); a.href = url; a.download = `도입현황-${report.month}.csv`; a.click();
    URL.revokeObjectURL(url);
  }

  let lastGroup = '';
  return (
    <section aria-label="월별 도입 현황" className="space-y-3 rounded-xl border border-slate-200 bg-white p-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="text-lg font-semibold text-slate-900">월별 도입 현황</h2>
          <p className="mt-0.5 text-sm text-slate-500">내 부서와 하위 부서의 한 달(한국 시간) 기록을 전월과 비교합니다. 기록된 숫자만 싣고, 절약한 시간 같은 추정치는 싣지 않습니다.</p>
        </div>
        <div className="flex items-center gap-2">
          <select aria-label="보고서 달" value={month} onChange={(e) => setMonth(e.target.value)} className="rounded-lg border border-slate-300 px-3 py-1.5 text-sm">
            {months.map((m) => <option key={m} value={m}>{m}</option>)}
          </select>
          <button type="button" onClick={download} disabled={!report} className="rounded-lg border border-slate-300 px-3 py-1.5 text-sm disabled:opacity-40">CSV 내려받기</button>
        </div>
      </div>
      {loading && <p role="status" className="text-sm text-slate-500">집계하는 중…</p>}
      {error && <p role="alert" className="text-sm text-red-700">{error}</p>}
      {report && !loading && (
        <>
          {report.partial && <p className="text-xs text-amber-700">이번 달은 아직 끝나지 않았습니다 — 오늘까지의 숫자입니다.</p>}
          <div className="overflow-x-auto">
            <table className="w-full text-left text-sm">
              <thead className="text-xs text-slate-500">
                <tr><th className="py-1 pr-3">지표</th><th className="pr-3 text-right">{report.month}</th><th className="pr-3 text-right">{report.previous}</th><th className="pr-3 text-right">전월 대비</th><th>읽는 법</th></tr>
              </thead>
              <tbody>
                {report.rows.map((r) => {
                  const head = r.group !== lastGroup; lastGroup = r.group;
                  return [
                    head && <tr key={`g-${r.group}`}><td colSpan={5} className="pt-3 text-xs font-semibold text-slate-400">{r.group}</td></tr>,
                    <tr key={r.key} className="border-t border-slate-100 align-top">
                      <td className="py-1.5 pr-3 text-slate-800">{r.label}</td>
                      <td className="pr-3 text-right font-semibold tabular-nums">{formatAdoptionValue(r.unit, r.value)}</td>
                      <td className="pr-3 text-right tabular-nums text-slate-500">{formatAdoptionValue(r.unit, r.previous)}</td>
                      <td className="pr-3 text-right tabular-nums">{formatAdoptionChange(r)}</td>
                      <td className="text-xs text-slate-500">{r.note}</td>
                    </tr>,
                  ];
                })}
              </tbody>
            </table>
          </div>
        </>
      )}
    </section>
  );
}
