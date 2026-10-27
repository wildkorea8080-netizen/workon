'use client';

import { useState } from 'react';
import { Card } from './WorkShell';
import type { CollectionResultDto } from './types';

/**
 * 취합 결과 — 숫자는 프로그램이 계산한 값이다(직원이 표 값을 고치지 않는다).
 * 직원이 정하는 것: 중복 후보를 넣을지·원자료를 뺄지·출력 단위·미제출 부서가 있어도 잠정 집계로 쓸지.
 * 결정을 바꾸면 원자료에서 다시 계산해 새 판·새 엑셀을 만든다.
 */
const STATUS: Record<string, string> = {
  used: '합산',
  duplicate: '중복 후보 — 합산 안 함',
  excluded: '직원이 뺌',
  no_department: '부서 모름 — 합산 안 함',
  no_table: '맞는 표 없음',
};

const fmt = (v: number | null | undefined, kind: string) =>
  v === null || v === undefined ? '—' : kind === 'rate' ? v.toFixed(2) : Math.round(v).toLocaleString('ko-KR');

export default function CollectionView({
  result,
  canEdit,
  busy,
  onRecompute,
}: {
  result: CollectionResultDto;
  canEdit: boolean;
  busy: boolean;
  onRecompute: (decisions: CollectionResultDto['decisions']) => void;
}) {
  const [d, setD] = useState(result.decisions);
  const dirty = JSON.stringify(d) !== JSON.stringify(result.decisions);
  const toggle = (list: 'excludedSourceIds' | 'includedSourceIds', id: string, on: boolean) =>
    setD({ ...d, [list]: on ? [...d[list], id] : d[list].filter((x) => x !== id) });

  return (
    <>
      <Card>
        <div className="mb-3 flex flex-wrap items-center gap-2">
          <h2 className="text-[16px] font-semibold">취합 결과</h2>
          <span className={`rounded-md px-2 py-0.5 text-[13px] font-medium ${result.provisional ? 'border border-amber-200 bg-amber-50 text-amber-900' : 'border border-emerald-200 bg-emerald-50 text-emerald-900'}`}>
            {result.provisional ? '미제출 부서를 제외한 잠정 집계' : '전 부서 제출 기준'}
          </span>
          <span className="text-[13px] text-slate-500">숫자는 원자료에서 프로그램이 계산했습니다(AI가 만든 숫자 아님).</span>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full min-w-[560px] text-right text-[15px]">
            <thead className="border-b border-[#DCE3EC] text-[13px] text-slate-500">
              <tr>
                <th scope="col" className="px-3 py-2 text-left font-medium">부서</th>
                {result.fields.map((f) => (
                  <th key={f.name} scope="col" className="px-3 py-2 font-medium">
                    {f.name}
                    {f.unit ? `(${f.unit})` : ''}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {result.departments.map((dep) => (
                <tr key={dep.name} className="border-b border-[#DCE3EC]">
                  <th scope="row" className="px-3 py-2 text-left font-medium">
                    {dep.name} {dep.status === 'missing' && <span className="text-[12px] text-amber-800">미제출</span>}
                  </th>
                  {result.fields.map((f) => (
                    <td key={f.name} className="px-3 py-2">{fmt(dep.values[f.name], f.kind)}</td>
                  ))}
                </tr>
              ))}
              <tr className="font-semibold">
                <th scope="row" className="px-3 py-2 text-left">{result.provisional ? '합계(잠정)' : '합계'}</th>
                {result.fields.map((f) => (
                  <td key={f.name} className="px-3 py-2">{fmt(result.totals[f.name], f.kind)}</td>
                ))}
              </tr>
            </tbody>
          </table>
        </div>
        {result.fields.filter((f) => f.derived).map((f) => (
          <p key={f.name} className="mt-2 text-[13px] text-slate-500">{f.name} = {f.derived}</p>
        ))}
      </Card>

      <Card>
        <h2 className="mb-2 text-[16px] font-semibold">제출 현황과 직원 결정</h2>
        <div className="overflow-x-auto">
          <table className="w-full min-w-[640px] text-left text-[14px]">
            <thead className="border-b border-[#DCE3EC] text-[13px] text-slate-500">
              <tr>
                <th scope="col" className="px-2 py-2 font-medium">원자료</th>
                <th scope="col" className="px-2 py-2 font-medium">부서</th>
                <th scope="col" className="px-2 py-2 font-medium">상태</th>
                <th scope="col" className="px-2 py-2 font-medium">항목 ↔ 열</th>
                <th scope="col" className="px-2 py-2 font-medium">합산에 넣기</th>
              </tr>
            </thead>
            <tbody>
              {result.sources.map((s) => {
                const isDup = s.status === 'duplicate' || d.includedSourceIds.includes(s.id);
                const included = isDup ? d.includedSourceIds.includes(s.id) : !d.excludedSourceIds.includes(s.id);
                return (
                  <tr key={s.id} className="border-b border-[#DCE3EC] align-top">
                    <td className="px-2 py-2 break-all">{s.name}</td>
                    <td className="px-2 py-2">{s.department ?? '—'}</td>
                    <td className="px-2 py-2">{STATUS[s.status] ?? s.status}</td>
                    <td className="px-2 py-2 text-[13px] text-slate-600">
                      {Object.entries(s.columnMap).map(([f, c]) => `${f} ← ${c ?? '없음'}${s.units[f] ? `(${s.units[f]})` : ''}`).join(' · ')}
                    </td>
                    <td className="px-2 py-2">
                      <label className="inline-flex items-center gap-1">
                        <input
                          type="checkbox"
                          disabled={!canEdit || busy || s.status === 'no_department' || s.status === 'no_table'}
                          checked={included}
                          onChange={(e) => (isDup ? toggle('includedSourceIds', s.id, e.target.checked) : toggle('excludedSourceIds', s.id, !e.target.checked))}
                        />
                        <span className="sr-only">{s.name} 합산에 넣기</span>
                      </label>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        {canEdit && (
          <div className="mt-4 flex flex-wrap items-center gap-4 text-[14px]">
            <label className="flex items-center gap-2">
              금액 단위
              <select value={d.outputUnit} onChange={(e) => setD({ ...d, outputUnit: e.target.value })} className="rounded-lg border border-[#DCE3EC] px-2 py-1">
                <option value="원">원</option>
                <option value="천원">천원</option>
                <option value="백만원">백만원</option>
              </select>
            </label>
            {result.departments.some((x) => x.status === 'missing') && (
              <label className="flex items-center gap-2">
                <input type="checkbox" checked={d.allowProvisional} onChange={(e) => setD({ ...d, allowProvisional: e.target.checked })} />
                미제출 부서를 뺀 잠정 집계로 쓰겠습니다
              </label>
            )}
            <button onClick={() => onRecompute(d)} disabled={!dirty || busy} className="ml-auto rounded-[10px] bg-[#003087] px-4 py-2 font-semibold text-white disabled:bg-slate-300">
              {busy ? '다시 계산 중…' : '결정 반영해 다시 취합'}
            </button>
          </div>
        )}
      </Card>
    </>
  );
}
