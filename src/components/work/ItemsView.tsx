'use client';

import { Card } from './WorkShell';
import type { ItemsDto } from './types';

const FLAG_LABEL: Record<string, string> = {
  quote_not_found: '원문에서 확인 못함',
  date_unverified: '날짜 확인 필요',
  relative_deadline: '상대 기한',
  person_unverified: '담당·화자 확인 필요',
  secret_removed: '비밀값 지움',
  source_unknown: '출처 불명',
};

/**
 * 원자료에서 뽑은 항목(요청사항·결정·미결 과제…) — 원문 인용과 확인 표시를 그대로 보인다.
 * 날짜·담당은 원자료에 적힌 것만 남았다(빈 칸 = 확인 필요). 고치려면 원자료를 고쳐 다시 만들거나 문서 칸을 고친다.
 */
export default function ItemsView({ data }: { data: ItemsDto }) {
  const cols = data.columns;
  const extra = data.extra ?? [];
  return (
    <Card>
      <h2 className="text-[16px] font-semibold">{data.name}</h2>
      <p className="mt-1 text-[13px] text-slate-600">원자료에 적힌 값만 옮겼습니다. 빈 날짜·담당은 원자료에 없어서 비운 것입니다(짐작하지 않음). 줄마다 원문 인용을 펼쳐 대조하세요.</p>
      {Object.values(data.meta).some(Boolean) && (
        <p className="mt-2 text-[13px] text-slate-700">{Object.entries(data.meta).filter(([, v]) => v).map(([k, v]) => `${k === 'place' ? '장소' : k === 'chair' ? '주관' : k === 'sender' ? '발신 기관' : k === 'docNumber' ? '문서번호' : k}: ${v}`).join(' · ')}</p>
      )}
      {data.items.length === 0 ? (
        <p className="mt-3 text-[14px] text-slate-500">뽑은 항목이 없습니다.</p>
      ) : (
        <div className="mt-3 overflow-x-auto">
          <table className="w-full min-w-[640px] border-collapse text-[13px]">
            <caption className="sr-only">{data.name}</caption>
            <thead>
              <tr className="border-b border-[#DCE3EC] text-left text-slate-600">
                <th scope="col" className="px-2 py-1.5">번호</th>
                <th scope="col" className="px-2 py-1.5">{data.typeLabel}</th>
                {cols.map((c) => (
                  <th key={c.key} scope="col" className="px-2 py-1.5">{c.label}</th>
                ))}
                {extra.map((e) => (
                  <th key={e.label} scope="col" className="px-2 py-1.5">{e.label}</th>
                ))}
                <th scope="col" className="px-2 py-1.5">확인</th>
              </tr>
            </thead>
            <tbody>
              {data.items.map((it) => (
                <tr key={it.id} className="border-b border-slate-100 align-top">
                  <td className="px-2 py-1.5 font-medium">{it.id}</td>
                  <td className="whitespace-nowrap px-2 py-1.5">{it.type}</td>
                  {cols.map((c) => {
                    const v = it.values[c.key];
                    const raw = c.type === 'date' && !v ? it.values[`${c.key}Text`] : undefined;
                    return (
                      <td key={c.key} className="px-2 py-1.5">
                        {v || (raw ? <span className="text-amber-800">{raw} (원문)</span> : <span className="text-slate-400">—</span>)}
                      </td>
                    );
                  })}
                  {extra.map((e) => (
                    <td key={e.label} className="px-2 py-1.5 text-slate-600">{e.values[it.id] || '—'}</td>
                  ))}
                  <td className="px-2 py-1.5">
                    {it.flags.length > 0 && <div className="text-amber-800">{it.flags.map((f) => FLAG_LABEL[f] ?? f).join(', ')}</div>}
                    <details>
                      <summary className="cursor-pointer text-[#003087]">원문</summary>
                      <p className="mt-1 whitespace-pre-wrap text-slate-700">{it.quote || '(인용 없음)'}</p>
                      <p className="text-[12px] text-slate-500">{it.sourceName ?? '출처 불명'}</p>
                      {it.notes.length > 0 && <p className="text-[12px] text-amber-800">{it.notes.join(' / ')}</p>}
                    </details>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Card>
  );
}
