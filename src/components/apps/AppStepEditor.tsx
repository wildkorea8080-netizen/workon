'use client';
import type { Dispatch, SetStateAction } from 'react';
import { APP_CONDITION_LABELS, APP_CONDITION_OPS, APP_MAX_BRANCHES, APP_MAX_RULES, type AppBranch, type AppConditionOp, type AppDefinition, type AppField, type AppRule, type AppStep } from '@/lib/apps/definition';
const input = 'w-full rounded-xl border border-slate-200 bg-white px-3 py-2.5 text-sm';

/** 항목을 고르거나 바꿀 때의 첫 규칙 — 비교는 그 종류의 첫 비교, 값은 목록이면 첫 선택값 */
export function defaultRule(field: AppField): AppRule {
  const op = APP_CONDITION_OPS[field.type][0];
  return { field: field.key, op, value: field.type === 'select' ? field.options?.[0] ?? '' : '' };
}
const needsValue = (op: AppConditionOp) => op !== 'filled' && op !== 'empty';

function RuleEditor({ rule, fields, label, disabled, onChange, onRemove }: { rule: AppRule; fields: AppField[]; label: string; disabled: boolean; onChange: (rule: AppRule) => void; onRemove: () => void }) {
  const field = fields.find(f => f.key === rule.field);
  const ops = field ? APP_CONDITION_OPS[field.type] : [];
  return <div className="grid gap-2 sm:grid-cols-[1fr_auto_1fr_auto] sm:items-center">
    <select aria-label={`${label} 항목`} className={input} value={rule.field} disabled={disabled} onChange={e => { const next = fields.find(f => f.key === e.target.value); if (next) onChange(defaultRule(next)); }}>
      {!field && <option value={rule.field} disabled>삭제된 항목</option>}{fields.map(f => <option key={f.key} value={f.key}>{f.label}</option>)}
    </select>
    <select aria-label={`${label} 비교`} className={input} value={rule.op} disabled={disabled || !field} onChange={e => { const op = e.target.value as AppConditionOp; onChange(needsValue(op) ? { ...rule, op, value: rule.value ?? (field?.type === 'select' ? field.options?.[0] ?? '' : '') } : { field: rule.field, op }); }}>
      {!ops.includes(rule.op) && <option value={rule.op} disabled>사용할 수 없는 비교</option>}{ops.map(op => <option key={op} value={op}>{APP_CONDITION_LABELS[op]}</option>)}
    </select>
    {!needsValue(rule.op) ? <span className="text-xs text-slate-400">값 없음</span>
      : field?.type === 'select' ? <select aria-label={`${label} 값`} className={input} value={rule.value ?? ''} disabled={disabled} onChange={e => onChange({ ...rule, value: e.target.value })}>
        {!field.options?.includes(rule.value ?? '') && <option value={rule.value ?? ''} disabled>현재 사용할 수 없는 값: {rule.value}</option>}{field.options?.map(option => <option key={option} value={option}>{option}</option>)}
      </select>
      : <input aria-label={`${label} 값`} className={input} disabled={disabled || !field} type={field?.type === 'number' ? 'number' : field?.type === 'date' ? 'date' : 'text'} maxLength={80} value={rule.value ?? ''} placeholder={field?.type === 'number' ? '숫자' : '비교할 글'} onChange={e => onChange({ ...rule, value: e.target.value })} />}
    <button type="button" className="text-xs text-red-600 disabled:opacity-30" disabled={disabled} onClick={onRemove}>조건 삭제</button>
  </div>;
}

/** 새 갈래 — 첫 항목의 기본 규칙 하나와 빈 지시. 이름은 몇 번째 갈래인지 */
export function defaultBranch(fields: AppField[], ordinal: number): AppBranch {
  return { name: `갈래 ${ordinal}`, when: { all: [defaultRule(fields[0])] }, instruction: '' };
}

/**
 * 단계의 갈래 하나 — 이름·조건(1~3개 AND)·이 갈래일 때의 지시. 갈래에는 조건이 꼭 하나는 있어야 해서
 * 마지막 조건은 지우지 못한다(갈래 자체를 지운다)
 */
function BranchEditor({ branch, fields, label, onChange, onRemove }: { branch: AppBranch; fields: AppField[]; label: string; onChange: (branch: AppBranch) => void; onRemove: () => void }) {
  const rules = branch.when.all;
  const changeRules = (next: AppRule[]) => { if (next.length) onChange({ ...branch, when: { all: next } }); };
  return <div className="space-y-2 rounded-lg border border-slate-200 bg-white p-3">
    <div className="flex items-center justify-between gap-2">
      <input className={input} aria-label={`${label} 이름`} maxLength={40} value={branch.name} onChange={e => onChange({ ...branch, name: e.target.value })} />
      <button type="button" className="shrink-0 text-xs text-red-600" onClick={onRemove}>갈래 삭제</button>
    </div>
    <div className="text-xs text-slate-500">이 갈래로 가는 조건 (모두 맞을 때)</div>
    {rules.map((rule, r) => <RuleEditor key={r} rule={rule} fields={fields} label={`${label} 조건 ${r + 1}`} disabled={false} onChange={next => changeRules(rules.map((x, i) => i === r ? next : x))} onRemove={() => changeRules(rules.filter((_, i) => i !== r))} />)}
    {rules.length < APP_MAX_RULES && <button type="button" className="text-xs text-[#087581]" onClick={() => changeRules([...rules, defaultRule(fields[0])])}>+ 조건 추가 (그리고)</button>}
    <textarea className={input} aria-label={`${label} 처리 지시`} maxLength={2000} rows={3} placeholder="이 갈래일 때의 처리 지시" value={branch.instruction} onChange={e => onChange({ ...branch, instruction: e.target.value })} />
  </div>;
}

export default function AppStepEditor({ definition, onChange }: { definition: AppDefinition; onChange: Dispatch<SetStateAction<AppDefinition>> }) {
  const fields = definition.fields;
  function changeStep(index: number, patch: Partial<AppStep>) { onChange(d => ({ ...d, steps: d.steps?.map((step, i) => i === index ? { ...step, ...patch } : step) })); }
  function changeRules(index: number, rules: AppRule[]) { changeStep(index, { when: rules.length ? { all: rules } : undefined }); }
  function changeBranches(index: number, branches: AppBranch[]) { changeStep(index, { branches: branches.length ? branches : undefined }); }
  return <section className="space-y-4 border-t pt-5"><h2 className="font-semibold">4. 단계별 처리 (선택)</h2>
    <p className="text-xs leading-5 text-slate-500">최대 3단계를 순서대로 처리합니다. 실행한 단계마다 AI 사용량이 발생합니다. 입력값에 따라 중간 단계를 생략할 수 있으며(조건은 단계마다 {APP_MAX_RULES}개까지, 모두 맞을 때 실행), 마지막 결과 작성 단계는 항상 실행합니다. 단계마다 갈래를 {APP_MAX_BRANCHES}개까지 두면 입력값에 따라 다른 지시로 처리합니다 — 위에서부터 처음 맞는 갈래 하나, 맞는 갈래가 없으면 기본 지시. 비워 둔 입력은 ‘비어 있음’ 조건에만 맞습니다. 외부 조회·파일 생성은 단계에서 지원하지 않습니다.</p>
    {!definition.steps?.length && <button type="button" className="text-sm text-[#087581]" onClick={() => onChange(d => ({ ...d, steps: [{ name: '자료 정리', instruction: '원문에 있는 사실과 요구 사항을 정리하세요.' }, { name: '초안 작성', instruction: '원문과 앞 단계의 정리 결과를 바탕으로 업무 초안을 작성하세요.' }, { name: '검토·보완', instruction: '원문과 초안을 대조해 근거 없는 표현을 고치고 최종 초안을 작성하세요.' }] }))}>정리 → 초안 → 검토 구성 추가</button>}
    {definition.steps?.map((step, index) => {
      const last = index === definition.steps!.length - 1;
      const rules = step.when?.all ?? [];
      return <div key={index} className="space-y-3 rounded-xl border border-slate-200 bg-slate-50 p-4">
        <div className="flex items-center justify-between gap-2"><span className="text-xs text-slate-500">단계 {index + 1}{last ? ' · 최종 결과' : ''}</span><div className="flex gap-3">
          {([-1, 1] as const).map(delta => <button key={delta} type="button" disabled={index + delta < 0 || index + delta >= (definition.steps?.length ?? 0)} aria-label={`단계 ${index + 1} ${delta === -1 ? '위로' : '아래로'}`} className="text-xs text-[#087581] disabled:opacity-30" onClick={() => onChange(d => { const steps = [...(d.steps ?? [])]; [steps[index], steps[index + delta]] = [steps[index + delta], steps[index]]; return { ...d, steps }; })}>{delta === -1 ? '위로' : '아래로'}</button>)}
          <button type="button" className="text-xs text-red-600" onClick={() => onChange(d => { const steps = d.steps?.filter((_, i) => i !== index); return { ...d, steps: steps?.length ? steps : undefined }; })}>단계 삭제</button>
        </div></div>
        <input className={input} aria-label={`단계 ${index + 1} 이름`} maxLength={40} value={step.name} onChange={e => changeStep(index, { name: e.target.value })} />
        <textarea className={input} aria-label={`단계 ${index + 1} 처리 지시`} maxLength={2000} rows={3} value={step.instruction} onChange={e => changeStep(index, { instruction: e.target.value })} />
        <label className="block text-xs text-slate-600">실행 조건<select aria-label={`단계 ${index + 1} 실행 조건`} className={`${input} mt-2`} value={rules.length ? 'when' : ''} onChange={e => changeRules(index, e.target.value ? [defaultRule(fields[0])] : [])}>
          <option value="">항상 실행</option><option value="when" disabled={last}>아래 조건이 모두 맞을 때만 실행</option>
        </select></label>
        {rules.map((rule, r) => <RuleEditor key={r} rule={rule} fields={fields} label={`단계 ${index + 1} 조건 ${r + 1}`} disabled={last} onChange={next => changeRules(index, rules.map((x, i) => i === r ? next : x))} onRemove={() => changeRules(index, rules.filter((_, i) => i !== r))} />)}
        {!last && rules.length > 0 && rules.length < APP_MAX_RULES && <button type="button" className="text-xs text-[#087581]" onClick={() => changeRules(index, [...rules, defaultRule(fields[0])])}>+ 조건 추가 (그리고)</button>}
        {last && step.when && <p role="alert" className="text-xs text-red-700">마지막 단계는 조건을 ‘항상 실행’으로 바꿔 주세요.</p>}
        <div className="space-y-2 border-t border-slate-200 pt-3">
          <div className="text-xs text-slate-600">갈래 (선택) — 위에서부터 처음 맞는 갈래의 지시로 처리하고, 맞는 갈래가 없으면 위의 기본 지시로 처리합니다</div>
          {(step.branches ?? []).map((branch, b) => <BranchEditor key={b} branch={branch} fields={fields} label={`단계 ${index + 1} 갈래 ${b + 1}`} onChange={next => changeBranches(index, (step.branches ?? []).map((x, i) => i === b ? next : x))} onRemove={() => changeBranches(index, (step.branches ?? []).filter((_, i) => i !== b))} />)}
          {(step.branches?.length ?? 0) < APP_MAX_BRANCHES && <button type="button" className="text-xs text-[#087581]" onClick={() => changeBranches(index, [...(step.branches ?? []), defaultBranch(fields, (step.branches?.length ?? 0) + 1)])}>+ 갈래 추가</button>}
        </div>
      </div>;
    })}
    {Boolean(definition.steps?.length) && (definition.steps?.length ?? 0) < 3 && <button type="button" className="text-sm text-[#087581]" onClick={() => onChange(d => ({ ...d, steps: [...(d.steps ?? []), { name: '추가 처리', instruction: '앞 단계의 결과를 바탕으로 최종 결과를 작성하세요.' }] }))}>+ 단계 추가</button>}
  </section>;
}
