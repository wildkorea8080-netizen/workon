'use client';
import type { Dispatch, SetStateAction } from 'react';
import type { AppDefinition, AppStep } from '@/lib/apps/definition';
const input = 'w-full rounded-xl border border-slate-200 bg-white px-3 py-2.5 text-sm';

export default function AppStepEditor({ definition, onChange }: { definition: AppDefinition; onChange: Dispatch<SetStateAction<AppDefinition>> }) {
  const fields = definition.fields.filter(field => field.type === 'select');
  function changeStep(index: number, patch: Partial<AppStep>) { onChange(d => ({ ...d, steps: d.steps?.map((step, i) => i === index ? { ...step, ...patch } : step) })); }
  return <section className="space-y-4 border-t pt-5"><h2 className="font-semibold">4. 단계별 처리 (선택)</h2>
    <p className="text-xs leading-5 text-slate-500">최대 3단계를 순서대로 처리합니다. 실행한 단계마다 AI 사용량이 발생합니다. 목록 선택 입력에 따라 중간 단계를 생략할 수 있으며, 마지막 결과 작성 단계는 항상 실행합니다. 외부 조회·파일 생성은 단계에서 지원하지 않습니다.</p>
    {!definition.steps?.length && <button type="button" className="text-sm text-[#087581]" onClick={() => onChange(d => ({ ...d, steps: [{ name: '자료 정리', instruction: '원문에 있는 사실과 요구 사항을 정리하세요.' }, { name: '초안 작성', instruction: '원문과 앞 단계의 정리 결과를 바탕으로 업무 초안을 작성하세요.' }, { name: '검토·보완', instruction: '원문과 초안을 대조해 근거 없는 표현을 고치고 최종 초안을 작성하세요.' }] }))}>정리 → 초안 → 검토 구성 추가</button>}
    {definition.steps?.map((step, index) => {
      const last = index === definition.steps!.length - 1;
      const selected = fields.find(field => field.key === step.when?.field);
      return <div key={index} className="space-y-3 rounded-xl border border-slate-200 bg-slate-50 p-4">
        <div className="flex items-center justify-between gap-2"><span className="text-xs text-slate-500">단계 {index + 1}{last ? ' · 최종 결과' : ''}</span><div className="flex gap-3">
          {([-1, 1] as const).map(delta => <button key={delta} type="button" disabled={index + delta < 0 || index + delta >= (definition.steps?.length ?? 0)} aria-label={`단계 ${index + 1} ${delta === -1 ? '위로' : '아래로'}`} className="text-xs text-[#087581] disabled:opacity-30" onClick={() => onChange(d => { const steps = [...(d.steps ?? [])]; [steps[index], steps[index + delta]] = [steps[index + delta], steps[index]]; return { ...d, steps }; })}>{delta === -1 ? '위로' : '아래로'}</button>)}
          <button type="button" className="text-xs text-red-600" onClick={() => onChange(d => { const steps = d.steps?.filter((_, i) => i !== index); return { ...d, steps: steps?.length ? steps : undefined }; })}>단계 삭제</button>
        </div></div>
        <input className={input} aria-label={`단계 ${index + 1} 이름`} maxLength={40} value={step.name} onChange={e => changeStep(index, { name: e.target.value })} />
        <textarea className={input} aria-label={`단계 ${index + 1} 처리 지시`} maxLength={2000} rows={3} value={step.instruction} onChange={e => changeStep(index, { instruction: e.target.value })} />
        <label className="block text-xs text-slate-600">실행 조건<select className={`${input} mt-2`} value={step.when?.field ?? ''} onChange={e => { const field = fields.find(f => f.key === e.target.value); changeStep(index, { when: field ? { field: field.key, equals: field.options?.[0] ?? '' } : undefined }); }}>
          <option value="">항상 실행</option>{step.when && !selected && <option value={step.when.field} disabled>삭제되거나 종류가 바뀐 항목</option>}{fields.map(field => <option key={field.key} value={field.key} disabled={last}>{field.label} 값으로 결정</option>)}
        </select></label>
        {step.when && <label className="block text-xs text-slate-600">이 값일 때만 실행<select className={`${input} mt-2`} value={step.when.equals} disabled={last || !selected} onChange={e => changeStep(index, { when: { field: step.when!.field, equals: e.target.value } })}>
          {!selected?.options?.includes(step.when.equals) && <option value={step.when.equals} disabled>현재 사용할 수 없는 값: {step.when.equals}</option>}{selected?.options?.map(option => <option key={option} value={option}>{option}</option>)}
        </select></label>}
        {last && step.when && <p role="alert" className="text-xs text-red-700">마지막 단계는 조건을 ‘항상 실행’으로 바꿔 주세요.</p>}
        {!last && !fields.length && <p className="text-xs text-slate-500">조건을 사용하려면 위 입력 항목에 ‘목록에서 선택’을 추가해 주세요.</p>}
      </div>;
    })}
    {Boolean(definition.steps?.length) && (definition.steps?.length ?? 0) < 3 && <button type="button" className="text-sm text-[#087581]" onClick={() => onChange(d => ({ ...d, steps: [...(d.steps ?? []), { name: '추가 처리', instruction: '앞 단계의 결과를 바탕으로 최종 결과를 작성하세요.' }] }))}>+ 단계 추가</button>}
  </section>;
}
