'use client';

import { useEffect, useState } from 'react';
import { DEPARTMENT_COLUMNS, departmentAdoptionCsv, departmentTotals, hasActivity, type DepartmentAdoption as Row } from '@/lib/department-adoption';

const fmt = (n: number) => n.toLocaleString('ko-KR');

/** 부서별 표(순수 렌더링) — 기록 없는 부서는 뒤로, 끝 줄은 합계 */
export function DepartmentAdoptionTable({ rows }: { rows: Row[] }) {
  if (!rows.length) return <p className="text-sm text-slate-500">관리 범위에 부서가 없습니다.</p>;
  const ordered = [...rows.filter(hasActivity), ...rows.filter((r) => !hasActivity(r))];
  const total = departmentTotals(rows);
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-left text-sm">
        <thead className="text-xs text-slate-500">
          <tr>
            <th className="py-1 pr-3">부서</th>
            {DEPARTMENT_COLUMNS.map((c) => <th key={c.key} className="pr-3 text-right">{c.label}</th>)}
          </tr>
        </thead>
        <tbody>
          {ordered.map((r) => (
            <tr key={r.departmentId} className={`border-t border-slate-100 ${hasActivity(r) ? '' : 'text-slate-400'}`}>
              <td className="py-1.5 pr-3">{r.name}</td>
              {DEPARTMENT_COLUMNS.map((c) => <td key={c.key} className="pr-3 text-right tabular-nums">{fmt(r[c.key])}</td>)}
            </tr>
          ))}
          <tr className="border-t border-slate-300 font-semibold">
            <td className="py-1.5 pr-3">합계</td>
            {DEPARTMENT_COLUMNS.map((c) => <td key={c.key} className="pr-3 text-right tabular-nums">{fmt(total[c.key])}</td>)}
          </tr>
        </tbody>
      </table>
    </div>
  );
}

/**
 * 월별 도입 현황의 부서별 보기(0065) — 펼칠 때만 불러온다. 부서마다 자기 부서의 기록만(하위 부서를 올려 더하지 않는다).
 * 사람 수는 지금 소속 부서로 센다
 */
export default function DepartmentAdoption({ month }: { month: string }) {
  const [open, setOpen] = useState(false);
  const [rows, setRows] = useState<Row[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    let active = true;
    setRows(null);
    setError(null);
    fetch(`/api/admin/adoption-report/departments?month=${encodeURIComponent(month)}`)
      .then((r) => r.json())
      .then((body) => {
        if (!active) return;
        if (body?.ok && Array.isArray(body.data?.departments)) setRows(body.data.departments as Row[]);
        else setError(body?.error?.message ?? '부서별 도입 현황을 불러오지 못했습니다.');
      })
      .catch(() => { if (active) setError('네트워크 오류가 발생했습니다.'); });
    return () => { active = false; };
  }, [open, month]);

  function download() {
    if (!rows) return;
    const url = URL.createObjectURL(new Blob([departmentAdoptionCsv(month, rows)], { type: 'text/csv;charset=utf-8' }));
    const a = document.createElement('a'); a.href = url; a.download = `부서별도입현황-${month}.csv`; a.click();
    URL.revokeObjectURL(url);
  }

  return (
    <details className="rounded-lg border border-slate-200 p-3" onToggle={(e) => setOpen((e.target as HTMLDetailsElement).open)}>
      <summary className="cursor-pointer text-sm font-semibold text-slate-800">부서별 보기 ({month})</summary>
      <div className="mt-3 space-y-2">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <p className="text-xs text-slate-500">부서마다 자기 부서의 기록만 셉니다(하위 부서를 올려 더하지 않음). 사람 수는 지금 소속 부서로 셉니다.</p>
          <button type="button" onClick={download} disabled={!rows} className="rounded-lg border border-slate-300 px-3 py-1.5 text-sm disabled:opacity-40">부서별 CSV</button>
        </div>
        {error ? <p role="alert" className="text-sm text-red-700">{error}</p> : rows === null ? <p role="status" className="text-sm text-slate-500">집계하는 중…</p> : <DepartmentAdoptionTable rows={rows} />}
      </div>
    </details>
  );
}
