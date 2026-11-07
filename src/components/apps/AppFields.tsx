'use client';
import { describeCondition, fieldRequired, type AppDefinition } from '@/lib/apps/definition';

export default function AppFields({ definition, values, onChange, disabled = false }: { definition: AppDefinition; values: Record<string, string>; onChange: (key: string, value: string) => void; disabled?: boolean }) {
  return <div className="space-y-5">{definition.fields.map(field => {
    // 조건부 필수는 지금 적은 다른 항목 값으로 판정한다(서버도 같은 판정으로 다시 본다)
    const required = fieldRequired(field, values);
    const props = { id: `app-input-${field.key}`, value: values[field.key] ?? '', required, disabled, onChange: (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>) => onChange(field.key, e.target.value), className: 'w-full rounded-xl border border-slate-200 bg-white px-3 py-2.5 text-sm disabled:bg-slate-50' };
    return <div key={field.key}><label htmlFor={props.id} className="mb-2 block text-sm font-medium">{field.label}{required && <span className="ml-1 text-ws-accent-text">(필수)</span>}{field.requiredWhen && <span className="ml-1 text-xs font-normal text-slate-500">{required ? '— ' : ''}{describeCondition(field.requiredWhen, definition.fields)}일 때 필수</span>}</label>{field.type === 'textarea' ? <textarea {...props} rows={5} maxLength={6000} /> : field.type === 'select' ? <select {...props}><option value="">선택해 주세요</option>{field.options?.map(option => <option key={option} value={option}>{option}</option>)}</select> : <input {...props} type={field.type} maxLength={500} step={field.type === 'number' ? 'any' : undefined} />}</div>;
  })}</div>;
}
