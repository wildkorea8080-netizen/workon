'use client';
import type { Dispatch, SetStateAction } from 'react';
import { APP_CLASSIFY_LABEL_MAX, APP_CLASSIFY_MAX, APP_REPEAT_MAX, repeatsFiles, APP_CONDITION_LABELS, APP_LOOKUP_ARTICLE_MAX, APP_LOOKUP_QUERY_MAX, APP_LOOKUP_TOOLS, APP_MAX_BRANCHES, APP_MAX_RULES, APP_MAX_STEPS, branchJumpIndex, conditionFields, conditionMode, conditionOpsFor, conditionRules, describeLookupQuery, isLookupTool, makeCondition, type AppBranch, type AppConditionMode, type AppConditionOp, type AppDefinition, type AppField, type AppLookupTool, type AppRule, type AppStep, type AppStepCondition } from '@/lib/apps/definition';
/** 반복 고르기의 '첨부 파일마다' 값 — 항목 키(영문·숫자·밑줄)와 겹치지 않는다 */
const FILES = '#files';
const input = 'w-full rounded-xl border border-slate-200 bg-white px-3 py-2.5 text-sm';

/** 항목을 고르거나 바꿀 때의 첫 규칙 — 비교는 그 종류의 첫 비교, 값은 목록이면 첫 선택값 */
export function defaultRule(field: AppField): AppRule {
  const op = conditionOpsFor(field)[0];
  return { field: field.key, op, value: field.type === 'select' ? field.options?.[0] ?? '' : '' };
}
const needsValue = (op: AppConditionOp) => op !== 'filled' && op !== 'empty';
/** 규칙을 묶는 방식의 이름 — 조건 추가 단추와 고르기 칸이 함께 쓴다 */
export const MODE_JOINER: Record<AppConditionMode, string> = { all: '그리고', any: '또는' };
export const MODE_LABEL: Record<AppConditionMode, string> = { all: '모두 맞을 때(그리고)', any: '하나라도 맞을 때(또는)' };

export function RuleEditor({ rule, fields, label, disabled, onChange, onRemove }: { rule: AppRule; fields: AppField[]; label: string; disabled: boolean; onChange: (rule: AppRule) => void; onRemove: () => void }) {
  const field = fields.find(f => f.key === rule.field);
  const ops = field ? conditionOpsFor(field) : [];
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

/**
 * 입력 항목의 '다른 항목에 따라 필수'(조건부 필수, 2026-11-08) — 늘 필수가 아닌 항목에만. 조건은 다른 입력 항목만 본다(자기 자신·분류 결과 아님).
 * 다른 항목이 없으면 감춘다(이미 걸린 조건은 보여 고치게 한다)
 */
export function RequiredWhenEditor({ field, fields, onChange }: { field: AppField; fields: AppField[]; onChange: (when: AppStepCondition | undefined) => void }) {
  const others = fields.filter(f => f.key !== field.key);
  const when = field.requiredWhen;
  if (field.required || (!others.length && !when)) return null;
  const rules = when ? conditionRules(when) : [];
  const mode = when ? conditionMode(when) : 'all';
  const set = (next: AppRule[], nextMode: AppConditionMode = mode) => onChange(next.length ? makeCondition(nextMode, next) : undefined);
  return <div className="space-y-2">
    <label className="flex items-center gap-2 text-sm"><input type="checkbox" aria-label={`${field.label} 조건부 필수`} checked={Boolean(when)} disabled={!others.length} onChange={e => set(e.target.checked ? [defaultRule(others[0])] : [])} />다른 항목에 따라 필수</label>
    {when && <div className="space-y-2 rounded-lg border border-slate-200 bg-white p-3">
      <select aria-label={`${field.label} 필수 조건 묶기`} className={input} value={mode} onChange={e => set(rules, e.target.value as AppConditionMode)}>
        <option value="all">아래 조건이 모두 맞을 때 필수</option><option value="any">아래 조건 중 하나라도 맞을 때 필수</option>
      </select>
      {rules.map((rule, r) => <RuleEditor key={r} rule={rule} fields={others} label={`${field.label} 필수 조건 ${r + 1}`} disabled={false} onChange={next => set(rules.map((x, i) => i === r ? next : x))} onRemove={() => set(rules.filter((_, i) => i !== r))} />)}
      {others.length > 0 && rules.length < APP_MAX_RULES && <button type="button" className="text-xs text-ws-accent-text" onClick={() => set([...rules, defaultRule(others[0])])}>+ 조건 추가 ({MODE_JOINER[mode]})</button>}
      <p className="text-xs leading-5 text-slate-500">조건이 맞으면 실행 화면에 ‘(필수)’가 붙고, 비워 두면 실행·예약·외부 연동 모두 거절됩니다.</p>
    </div>}
  </div>;
}

/** 새 갈래 — 첫 항목의 기본 규칙 하나와 빈 지시. 이름은 몇 번째 갈래인지 */
export function defaultBranch(fields: AppField[], ordinal: number): AppBranch {
  return { name: `갈래 ${ordinal}`, when: { all: [defaultRule(fields[0])] }, instruction: '' };
}

/**
 * 단계의 갈래 하나 — 이름·조건(1~3개, 모두 또는 하나라도)·이 갈래일 때의 지시. 갈래에는 조건이 꼭 하나는 있어야 해서
 * 마지막 조건은 지우지 못한다(갈래 자체를 지운다)
 */
function BranchEditor({ branch, fields, label, stepIndex, steps, onChange, onRemove }: { branch: AppBranch; fields: AppField[]; label: string; stepIndex: number; steps: AppStep[]; onChange: (branch: AppBranch) => void; onRemove: () => void }) {
  const rules = conditionRules(branch.when);
  // 건너갈 단계(2026-11-08) — 이 단계보다 두 단계 이상 뒤만. 단계 순서를 바꿔 맞지 않게 된 값은 저장 전에 알린다
  const targets = steps.map((s, i) => ({ number: i + 1, name: s.name })).filter(t => t.number >= stepIndex + 3);
  const brokenNext = branch.next !== undefined && branchJumpIndex(stepIndex, branch, steps.length) === null;
  const mode = conditionMode(branch.when);
  const changeRules = (next: AppRule[], nextMode: AppConditionMode = mode) => { if (next.length) onChange({ ...branch, when: makeCondition(nextMode, next) }); };
  return <div className="space-y-2 rounded-lg border border-slate-200 bg-white p-3">
    <div className="flex items-center justify-between gap-2">
      <input className={input} aria-label={`${label} 이름`} maxLength={40} value={branch.name} onChange={e => onChange({ ...branch, name: e.target.value })} />
      <button type="button" className="shrink-0 text-xs text-red-600" onClick={onRemove}>갈래 삭제</button>
    </div>
    <label className="block text-xs text-slate-500">이 갈래로 가는 조건<select aria-label={`${label} 조건 묶음`} className={`${input} mt-1`} value={mode} onChange={e => changeRules(rules, e.target.value as AppConditionMode)}>
      <option value="all">{MODE_LABEL.all}</option><option value="any">{MODE_LABEL.any}</option>
    </select></label>
    {rules.map((rule, r) => <RuleEditor key={r} rule={rule} fields={fields} label={`${label} 조건 ${r + 1}`} disabled={false} onChange={next => changeRules(rules.map((x, i) => i === r ? next : x))} onRemove={() => changeRules(rules.filter((_, i) => i !== r))} />)}
    {rules.length < APP_MAX_RULES && <button type="button" className="text-xs text-ws-accent-text" onClick={() => changeRules([...rules, defaultRule(fields[0])])}>+ 조건 추가 ({MODE_JOINER[mode]})</button>}
    <textarea className={input} aria-label={`${label} 처리 지시`} maxLength={2000} rows={3} placeholder="이 갈래일 때의 처리 지시" value={branch.instruction} onChange={e => onChange({ ...branch, instruction: e.target.value })} />
    {(targets.length > 0 || branch.next !== undefined) && <label className="block text-xs text-slate-500">이 갈래로 처리한 뒤<select aria-label={`${label} 다음 단계`} className={`${input} mt-1`} value={branch.next ?? ''} onChange={e => { const { next: _next, ...rest } = branch; void _next; onChange(e.target.value ? { ...rest, next: Number(e.target.value) } : rest); }}>
      <option value="">바로 다음 단계로</option>
      {targets.map(t => <option key={t.number} value={t.number}>단계 {t.number}({t.name})로 건너가기 — 사이 단계는 건너뜀</option>)}
      {brokenNext && <option value={branch.next}>단계 {branch.next}(지금은 갈 수 없음)</option>}
    </select></label>}
    {brokenNext && <p role="alert" className="text-xs text-red-700">단계 순서가 바뀌어 건너갈 단계가 맞지 않습니다 — 다시 골라 주세요.</p>}
  </div>;
}

/** 처리 방식을 바꿀 때의 단계 — 조회로 가면 갈래를 떼고 첫 입력 항목을 조회어로, AI로 돌아오면 지시가 비었으면 기본 지시 */
export function switchStepKind(step: AppStep, kind: '' | AppLookupTool, fields: AppField[]): AppStep {
  if (!kind) {
    const { lookup: _lookup, ...rest } = step;
    return { ...rest, instruction: step.instruction.trim() ? step.instruction : '앞 단계의 조회 결과와 원래 입력을 바탕으로 정리하세요.' };
  }
  const { branches: _branches, classify: _classify, repeat: _repeat, ...rest } = step;
  // 조문 칸은 본문 도구끼리만 이어 간다(검색 도구에는 둘 수 없다)
  const article = APP_LOOKUP_TOOLS[kind].article && step.lookup?.article ? { article: step.lookup.article } : {};
  return { ...rest, lookup: { tool: kind, query: step.lookup?.query ?? (fields[0] ? `{{${fields[0].key}}}` : ''), ...article } };
}

export default function AppStepEditor({ definition, onChange, lookupTools = [] }: { definition: AppDefinition; onChange: Dispatch<SetStateAction<AppDefinition>>; lookupTools?: AppLookupTool[] }) {
  const fields = definition.fields;
  function changeStep(index: number, patch: Partial<AppStep>) { onChange(d => ({ ...d, steps: d.steps?.map((step, i) => i === index ? { ...step, ...patch } : step) })); }
  function changeRules(index: number, rules: AppRule[], mode: AppConditionMode) { changeStep(index, { when: rules.length ? makeCondition(mode, rules) : undefined }); }
  function changeBranches(index: number, branches: AppBranch[]) { changeStep(index, { branches: branches.length ? branches : undefined }); }
  return <section className="space-y-4 border-t pt-5"><h2 className="font-semibold">4. 단계별 처리 (선택)</h2>
    <p className="text-xs leading-5 text-slate-500">최대 {APP_MAX_STEPS}단계를 순서대로 처리합니다. 실행한 단계마다 AI 사용량이 발생합니다. 입력값에 따라 중간 단계를 생략할 수 있으며(조건은 단계마다 {APP_MAX_RULES}개까지 — 모두 맞을 때 또는 하나라도 맞을 때 실행, 앞 분류 단계의 결과로도 가를 수 있음), 마지막 결과 작성 단계는 항상 실행합니다. 단계마다 갈래를 {APP_MAX_BRANCHES}개까지 두면 입력값에 따라 다른 지시로 처리합니다 — 위에서부터 처음 맞는 갈래 하나, 맞는 갈래가 없으면 기본 지시. 갈래마다 처리한 뒤 뒤쪽 단계로 건너가게 할 수 있습니다(앞으로만 — 사이 단계는 건너뛰고, 여러 갈래가 같은 단계로 가면 거기서 합쳐집니다). 비워 둔 입력은 ‘비어 있음’ 조건에만 맞습니다. 중간 단계는 처리 방식을 ‘공공 데이터 조회’로 바꿔 법령·통계표·입찰공고 검색을 정해 둔 조회어로 한 번 부를 수 있습니다(기관이 쓰는 공공 데이터만, AI 사용량 없음). ‘문서 찾기’로 바꾸면 이 앱 비서의 문서함을 정해 둔 조회어로 찾습니다(근거가 없으면 정보 공백으로 넘김). 파일 생성·외부 시스템 변경은 단계에서 지원하지 않습니다.</p>
    {!definition.steps?.length && <button type="button" className="text-sm text-ws-accent-text" onClick={() => onChange(d => ({ ...d, steps: [{ name: '자료 정리', instruction: '원문에 있는 사실과 요구 사항을 정리하세요.' }, { name: '초안 작성', instruction: '원문과 앞 단계의 정리 결과를 바탕으로 업무 초안을 작성하세요.' }, { name: '검토·보완', instruction: '원문과 초안을 대조해 근거 없는 표현을 고치고 최종 초안을 작성하세요.' }] }))}>정리 → 초안 → 검토 구성 추가</button>}
    {definition.steps?.map((step, index) => {
      const last = index === definition.steps!.length - 1;
      // 이 단계의 조건·갈래가 볼 수 있는 항목 — 입력 항목 + 앞선 분류 단계의 결과
      const visible = conditionFields(fields, definition.steps, index);
      const rules = step.when ? conditionRules(step.when) : [];
      const mode: AppConditionMode = step.when ? conditionMode(step.when) : 'all';
      return <div key={index} className="space-y-3 rounded-xl border border-slate-200 bg-slate-50 p-4">
        <div className="flex items-center justify-between gap-2"><span className="text-xs text-slate-500">단계 {index + 1}{last ? ' · 최종 결과' : ''}</span><div className="flex gap-3">
          {([-1, 1] as const).map(delta => <button key={delta} type="button" disabled={index + delta < 0 || index + delta >= (definition.steps?.length ?? 0)} aria-label={`단계 ${index + 1} ${delta === -1 ? '위로' : '아래로'}`} className="text-xs text-ws-accent-text disabled:opacity-30" onClick={() => onChange(d => { const steps = [...(d.steps ?? [])]; [steps[index], steps[index + delta]] = [steps[index + delta], steps[index]]; return { ...d, steps }; })}>{delta === -1 ? '위로' : '아래로'}</button>)}
          <button type="button" className="text-xs text-red-600" onClick={() => onChange(d => { const steps = d.steps?.filter((_, i) => i !== index); return { ...d, steps: steps?.length ? steps : undefined }; })}>단계 삭제</button>
        </div></div>
        <input className={input} aria-label={`단계 ${index + 1} 이름`} maxLength={40} value={step.name} onChange={e => changeStep(index, { name: e.target.value })} />
        <label className="block text-xs text-slate-600">처리 방식<select aria-label={`단계 ${index + 1} 처리 방식`} className={`${input} mt-2`} value={step.lookup?.tool ?? ''} onChange={e => { const kind = e.target.value; if (kind === '' || isLookupTool(kind)) onChange(d => ({ ...d, steps: d.steps?.map((s, i) => i === index ? switchStepKind(s, kind, d.fields) : s) })); }}>
          <option value="">AI 처리</option>
          {(Object.keys(APP_LOOKUP_TOOLS) as AppLookupTool[]).map(tool => <option key={tool} value={tool} disabled={last || !lookupTools.includes(tool)}>{APP_LOOKUP_TOOLS[tool].capability === 'doc_search' ? APP_LOOKUP_TOOLS[tool].label : `공공 데이터 조회 — ${APP_LOOKUP_TOOLS[tool].label}`}{lookupTools.includes(tool) ? '' : ' (기관에서 쓰지 않음)'}</option>)}
        </select></label>
        {step.lookup ? <div className="space-y-2 rounded-lg border border-teal-100 bg-white p-3">
          <input className={input} aria-label={`단계 ${index + 1} 조회어`} maxLength={APP_LOOKUP_QUERY_MAX} value={step.lookup.query} placeholder="조회어 — 입력 항목을 넣으려면 아래 단추를 누르세요" onChange={e => changeStep(index, { lookup: { ...step.lookup!, query: e.target.value } })} />
          <div className="flex flex-wrap gap-2">{fields.map(f => <button key={f.key} type="button" className="rounded-full border border-slate-200 px-2 py-0.5 text-xs text-ws-accent-text" onClick={() => changeStep(index, { lookup: { ...step.lookup!, query: `${step.lookup!.query}${step.lookup!.query && !step.lookup!.query.endsWith(' ') ? ' ' : ''}{{${f.key}}}`.slice(0, APP_LOOKUP_QUERY_MAX) } })}>+ {f.label}</button>)}</div>
          {APP_LOOKUP_TOOLS[step.lookup.tool].article && <div className="space-y-2">
            <input className={input} aria-label={`단계 ${index + 1} 조문 번호`} maxLength={APP_LOOKUP_ARTICLE_MAX} value={step.lookup.article ?? ''} placeholder="조문 번호(선택) — 예: 15 또는 제15조. 비우면 앞 조문부터" onChange={e => changeStep(index, { lookup: { ...step.lookup!, article: e.target.value || undefined } })} />
            <div className="flex flex-wrap gap-2">{fields.map(f => <button key={f.key} type="button" className="rounded-full border border-slate-200 px-2 py-0.5 text-xs text-ws-accent-text" onClick={() => changeStep(index, { lookup: { ...step.lookup!, article: `{{${f.key}}}` } })}>조문 번호 = {f.label}</button>)}</div>
          </div>}
          {APP_LOOKUP_TOOLS[step.lookup.tool].capability === 'doc_search' ? <p className="text-xs leading-5 text-slate-500">찾을 조회어: {describeLookupQuery(step.lookup.query, fields) || '(비어 있음)'} — AI를 부르지 않고 이 앱 비서에 올린 문서(기관 유형의 공통 기준 포함)를 대화와 같은 규칙으로 찾습니다. 찾은 근거(문서 이름·쪽)는 다음 단계의 자료가 되고, <strong>근거가 없으면 멈추지 않고 ‘정보 공백’으로 넘겨</strong> 결과에 확인 필요로 밝히게 합니다. 조회어를 다르게 한 문서 찾기 단계를 여럿 두면 주제마다 따로 찾습니다. 저장하면 앱의 문서 찾기가 켜집니다 — 앱 비서에 문서를 올려 두세요.</p> : <p className="text-xs leading-5 text-slate-500">보낼 조회어: {describeLookupQuery(step.lookup.query, fields) || '(비어 있음)'}{step.lookup.article ? ` · 조문: ${describeLookupQuery(step.lookup.article, fields)}` : ''} — AI를 부르지 않고 {APP_LOOKUP_TOOLS[step.lookup.tool].label}을 한 번 부릅니다{APP_LOOKUP_TOOLS[step.lookup.tool].appOnly ? '(검색해 이름이 같은 결과, 없으면 첫 결과의 본문 — 어느 법령을 골랐는지 결과 머리에 적힙니다)' : ''}. 결과(원문 링크 포함)는 다음 단계의 자료가 되고 답변 출처에 붙습니다. 조회어가 비면 실행이 멈추니, 비워 둘 수 있는 항목이면 ‘입력됨’ 조건을 두세요.</p>}
          {!lookupTools.includes(step.lookup.tool) && <p role="alert" className="text-xs text-red-700">이 기관에서 쓰지 않는 공공 데이터라 실행되지 않습니다. 다른 조회를 고르거나 AI 처리로 바꿔 주세요.</p>}
          {last && <p role="alert" className="text-xs text-red-700">마지막 결과 작성 단계는 AI 처리여야 합니다. 조회 단계를 위로 옮겨 주세요.</p>}
        </div>
        : <textarea className={input} aria-label={`단계 ${index + 1} 처리 지시`} maxLength={2000} rows={3} placeholder={step.classify ? '분류 기준 — 예: 요청이 처리해 달라는 것이면 민원, 묻는 것이면 질의' : undefined} value={step.instruction} onChange={e => changeStep(index, { instruction: e.target.value })} />}
        {!step.lookup && <div className="space-y-2">
          <label className="flex items-center gap-2 text-xs text-slate-600"><input type="checkbox" aria-label={`단계 ${index + 1} 분류 단계`} disabled={last} checked={Boolean(step.classify)} onChange={e => changeStep(index, e.target.checked ? { classify: { options: ['예', '아니오'] }, branches: undefined, repeat: undefined } : { classify: undefined })} />분류 단계로 쓰기 — AI가 아래 선택지 중 하나만 고르고, 뒤 단계의 조건·갈래가 그 결과로 가릅니다{last ? ' (마지막 단계는 안 됨)' : ''}</label>
          {step.classify && <>
            <input className={input} aria-label={`단계 ${index + 1} 분류 선택지`} value={step.classify.options.join(',')} placeholder="선택지를 쉼표로 — 예: 민원,질의,제안" onChange={e => changeStep(index, { classify: { options: e.target.value.split(',').slice(0, APP_CLASSIFY_MAX) } })} />
            <p className="text-xs leading-5 text-slate-500">선택지는 {APP_CLASSIFY_MAX}개까지, 하나에 {APP_CLASSIFY_LABEL_MAX}자까지. AI가 선택지 밖의 답을 내면 단계가 멈춥니다(지어낸 분류로 가지 않음). 뒤 단계의 조건 항목에 ‘{index + 1}단계 분류 결과’가 생깁니다.</p>
          </>}
        </div>}
        <label className="block text-xs text-slate-600">실행 조건<select aria-label={`단계 ${index + 1} 실행 조건`} className={`${input} mt-2`} value={rules.length ? mode : ''} onChange={e => { const next = e.target.value as AppConditionMode | ''; changeRules(index, next ? (rules.length ? rules : [defaultRule(fields[0])]) : [], next || 'all'); }}>
          <option value="">항상 실행</option><option value="all" disabled={last}>아래 조건이 모두 맞을 때만 실행</option><option value="any" disabled={last}>아래 조건 중 하나라도 맞을 때 실행</option>
        </select></label>
        {rules.map((rule, r) => <RuleEditor key={r} rule={rule} fields={visible} label={`단계 ${index + 1} 조건 ${r + 1}`} disabled={last} onChange={next => changeRules(index, rules.map((x, i) => i === r ? next : x), mode)} onRemove={() => changeRules(index, rules.filter((_, i) => i !== r), mode)} />)}
        {!last && rules.length > 0 && rules.length < APP_MAX_RULES && <button type="button" className="text-xs text-ws-accent-text" onClick={() => changeRules(index, [...rules, defaultRule(fields[0])], mode)}>+ 조건 추가 ({MODE_JOINER[mode]})</button>}
        {last && step.when && <p role="alert" className="text-xs text-red-700">마지막 단계는 조건을 ‘항상 실행’으로 바꿔 주세요.</p>}
        {!step.lookup && !step.classify && (() => {
          const lists = fields.filter(f => f.type === 'textarea');
          // 파일마다 반복(2026-11-07) — 파일 첨부 받기를 켠 앱만. 고르는 값은 항목 키 또는 FILES
          const files = Boolean(definition.attachments);
          const first = lists[0] ? { field: lists[0].key } : files ? { files: true as const } : undefined;
          const value = repeatsFiles(step.repeat) ? FILES : step.repeat && 'field' in step.repeat ? step.repeat.field : '';
          return <div className="space-y-2">
            <label className="flex items-center gap-2 text-xs text-slate-600"><input type="checkbox" aria-label={`단계 ${index + 1} 반복`} disabled={last || !first} checked={Boolean(step.repeat)} onChange={e => changeStep(index, { repeat: e.target.checked ? first : undefined })} />반복 — 긴 글 입력의 한 줄마다, 또는 첨부 파일마다 이 단계를 한 번씩 처리하고 결과를 이어 붙입니다(최대 {APP_REPEAT_MAX}번, 한 번마다 AI 사용량){last ? ' (마지막 단계는 안 됨)' : !first ? ' (긴 글 입력 항목이나 파일 첨부 받기가 있어야 함)' : ''}</label>
            {step.repeat && <select aria-label={`단계 ${index + 1} 반복할 항목`} className={input} value={value} onChange={e => changeStep(index, { repeat: e.target.value === FILES ? { files: true } : { field: e.target.value } })}>
              {value !== FILES && !lists.some(f => f.key === value) && <option value={value} disabled>삭제된 항목</option>}
              {value === FILES && !files && <option value={FILES} disabled>첨부 파일마다 (파일 첨부 받기가 꺼짐)</option>}
              {lists.map(f => <option key={f.key} value={f.key}>{f.label}의 줄마다</option>)}
              {files && <option value={FILES}>첨부 파일마다 (문서함에서 고른 문서 포함)</option>}
            </select>}
          </div>;
        })()}
        {!step.lookup && !step.classify && <div className="space-y-2 border-t border-slate-200 pt-3">
          <div className="text-xs text-slate-600">갈래 (선택) — 위에서부터 처음 맞는 갈래의 지시로 처리하고, 맞는 갈래가 없으면 위의 기본 지시로 처리합니다</div>
          {(step.branches ?? []).map((branch, b) => <BranchEditor key={b} branch={branch} fields={visible} label={`단계 ${index + 1} 갈래 ${b + 1}`} stepIndex={index} steps={definition.steps ?? []} onChange={next => changeBranches(index, (step.branches ?? []).map((x, i) => i === b ? next : x))} onRemove={() => changeBranches(index, (step.branches ?? []).filter((_, i) => i !== b))} />)}
          {(step.branches?.length ?? 0) < APP_MAX_BRANCHES && <button type="button" className="text-xs text-ws-accent-text" onClick={() => changeBranches(index, [...(step.branches ?? []), defaultBranch(fields, (step.branches?.length ?? 0) + 1)])}>+ 갈래 추가</button>}
        </div>}
      </div>;
    })}
    {Boolean(definition.steps?.length) && (definition.steps?.length ?? 0) < APP_MAX_STEPS && <button type="button" className="text-sm text-ws-accent-text" onClick={() => onChange(d => ({ ...d, steps: [...(d.steps ?? []), { name: '추가 처리', instruction: '앞 단계의 결과를 바탕으로 최종 결과를 작성하세요.' }] }))}>+ 단계 추가</button>}
  </section>;
}
