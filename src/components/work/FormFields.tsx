'use client';

import type { WorkflowInputDto } from './types';

/**
 * 업무 입력 폼 — 카탈로그의 입력 형식대로 그린다. 파일(file-set)·양식(template)은 따로 고른다.
 * 모든 칸에 라벨을 잇고(접근성), 필수 칸은 글로도 알린다(색만으로 구분하지 않는다).
 */
export type FormState = Record<string, unknown>;

export default function FormFields({
  inputs,
  value,
  onChange,
  disabled,
  missing = [],
}: {
  inputs: WorkflowInputDto[];
  value: FormState;
  onChange: (next: FormState) => void;
  disabled?: boolean;
  missing?: string[];
}) {
  const set = (key: string, v: unknown) => onChange({ ...value, [key]: v });
  return (
    <div className="space-y-5">
      {inputs
        .filter((i) => i.type !== 'file-set' && i.type !== 'template' && i.key !== 'title')
        .map((i) => {
          const id = `in-${i.key}`;
          const errId = `${id}-err`;
          const isMissing = missing.includes(i.key);
          const common = {
            id,
            disabled,
            'aria-required': i.required,
            'aria-invalid': isMissing || undefined,
            'aria-describedby': isMissing ? errId : undefined,
            className: 'mt-1 w-full rounded-[10px] border border-[#DCE3EC] bg-white px-3 py-2.5 text-[15px] focus:border-[#003087] focus:outline-none focus:ring-2 focus:ring-[#003087]/20 disabled:bg-slate-50',
          };
          return (
            <div key={i.key}>
              <label htmlFor={id} className="text-[15px] font-medium">
                {i.label} {i.required ? <span className="text-[13px] text-red-700">(필수)</span> : <span className="text-[13px] text-slate-500">(선택)</span>}
              </label>
              {i.type === 'long-text' && <textarea {...common} rows={6} value={String(value[i.key] ?? '')} onChange={(e) => set(i.key, e.target.value)} />}
              {i.type === 'string' && <input {...common} value={String(value[i.key] ?? '')} onChange={(e) => set(i.key, e.target.value)} />}
              {i.type === 'date' && <input {...common} type="date" value={String(value[i.key] ?? '')} onChange={(e) => set(i.key, e.target.value)} />}
              {i.type === 'enum' && (
                <select {...common} value={String(value[i.key] ?? '')} onChange={(e) => set(i.key, e.target.value)}>
                  <option value="">고르세요</option>
                  {i.options?.map((o) => (
                    <option key={o} value={o}>
                      {o}
                    </option>
                  ))}
                </select>
              )}
              {i.type === 'string-list' && (
                <>
                  <textarea
                    {...common}
                    rows={3}
                    value={Array.isArray(value[i.key]) ? (value[i.key] as string[]).join('\n') : String(value[i.key] ?? '')}
                    onChange={(e) => set(i.key, e.target.value.split('\n'))}
                  />
                  <p className="mt-1 text-[13px] text-slate-500">한 줄에 하나씩 적습니다.</p>
                </>
              )}
              {i.type === 'record-list' && (
                <>
                  <textarea
                    {...common}
                    rows={3}
                    value={Array.isArray(value[i.key]) ? (value[i.key] as { name: string }[]).map((r) => (typeof r === 'string' ? r : r.name)).join('\n') : ''}
                    onChange={(e) => set(i.key, e.target.value.split('\n').map((name) => ({ name })))}
                  />
                  <p className="mt-1 text-[13px] text-slate-500">한 줄에 하나씩 적습니다(예: 실적 제출 양식 1부).</p>
                </>
              )}
              {isMissing && (
                <p id={errId} className="mt-1 text-[13px] text-red-700">
                  {i.label}을(를) 적어 주세요.
                </p>
              )}
            </div>
          );
        })}
    </div>
  );
}

/** 보내기 전에 빈 줄을 정리한다(서버가 다시 검사한다) */
export function cleanForm(inputs: WorkflowInputDto[], value: FormState): FormState {
  const out: FormState = {};
  for (const i of inputs) {
    const v = value[i.key];
    if (v === undefined || v === '') continue;
    if (i.type === 'string-list' && Array.isArray(v)) {
      const items = (v as string[]).map((s) => s.trim()).filter(Boolean);
      if (items.length) out[i.key] = items;
    } else if (i.type === 'record-list' && Array.isArray(v)) {
      const items = (v as { name: string }[]).filter((r) => r?.name?.trim());
      if (items.length) out[i.key] = items;
    } else out[i.key] = v;
  }
  return out;
}
