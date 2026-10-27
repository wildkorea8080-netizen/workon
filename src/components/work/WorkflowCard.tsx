'use client';

import Link from 'next/link';
import type { WorkflowSummaryDto } from './types';

/** 업무 비서 카드 — 무엇을 넣으면 어떤 파일이 나오는지. 모델명은 보이지 않는다. 준비 중이면 이유와 함께 시작 단추를 막는다 */
export default function WorkflowCard({ workflow, canStart }: { workflow: WorkflowSummaryDto; canStart: boolean }) {
  const needs = workflow.inputs.filter((i) => i.required && i.type !== 'template').map((i) => i.label);
  return (
    <article className="flex flex-col rounded-xl border border-[#DCE3EC] bg-white p-5">
      <div className="mb-2 flex items-center justify-between gap-2">
        <h3 className="text-[17px] font-semibold">{workflow.name}</h3>
        <div className="flex gap-1">
          {workflow.outputs.map((o) => (
            <span key={o.key} className="rounded border border-[#DCE3EC] px-1.5 py-0.5 text-[12px] font-semibold text-slate-600" title={o.label}>
              {o.format.toUpperCase()}
            </span>
          ))}
        </div>
      </div>
      <p className="text-[14px] text-slate-600">{workflow.purpose}</p>
      <p className="mt-2 text-[13px] text-slate-500">필요한 것: {needs.join(', ')}</p>
      <div className="mt-auto pt-4">
        {workflow.available ? (
          canStart ? (
            <Link
              href={`/tasks/new?workflow=${workflow.key}`}
              className="inline-block rounded-[10px] bg-[#003087] px-4 py-2 text-[14px] font-semibold text-white hover:bg-[#002070]"
            >
              시작
            </Link>
          ) : (
            <span className="text-[13px] text-slate-500">기관에서 아직 켜지 않음</span>
          )
        ) : (
          <span className="inline-flex items-center gap-1 rounded-md bg-slate-100 px-2 py-1 text-[13px] text-slate-600" title={workflow.reason ?? undefined}>
            준비 중 — {workflow.reason}
          </span>
        )}
      </div>
    </article>
  );
}
