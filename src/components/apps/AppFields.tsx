'use client';
import type { AppDefinition } from '@/lib/apps/definition';

export default function AppFields({ definition, values, onChange, disabled = false }: { definition: AppDefinition; values: Record<string, string>; onChange: (key: string, value: string) => void; disabled?: boolean }) {
  return <div className="space-y-5">{definition.fields.map(field => {
    const props = { id: `app-input-${field.key}`, value: values[field.key] ?? '', required: field.required, disabled, onChange: (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>) => onChange(field.key, e.target.value), className: 'w-full rounded-xl border border-slate-200 bg-white px-3 py-2.5 text-sm disabled:bg-slate-50' };
    return <div key={field.key}><label htmlFor={props.id} className="mb-2 block text-sm font-medium">{field.label}{field.required && <span className="ml-1 text-[#087581]">(필수)</span>}</label>{field.type === 'textarea' ? <textarea {...props} rows={5} maxLength={6000} /> : field.type === 'select' ? <select {...props}><option value="">선택해 주세요</option>{field.options?.map(option => <option key={option} value={option}>{option}</option>)}</select> : <input {...props} type={field.type} maxLength={500} step={field.type === 'number' ? 'any' : undefined} />}</div>;
  })}</div>;
}
