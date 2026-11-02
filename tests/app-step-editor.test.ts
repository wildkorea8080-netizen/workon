import { describe, expect, it } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import AppStepEditor, { defaultBranch, defaultRule } from '@/components/apps/AppStepEditor';
import { validateAppDefinition, type AppDefinition, type AppField, type AppStepCondition } from '@/lib/apps/definition';

const fields: AppField[] = [
  { key: 'kind', label: '종류', type: 'select', required: true, options: ['안내', '공지'] },
  { key: 'memo', label: '메모', type: 'textarea', required: false },
  { key: 'count', label: '인원', type: 'number', required: false },
  { key: 'due', label: '마감일', type: 'date', required: false },
];
const html = (definition: AppDefinition) => renderToStaticMarkup(createElement(AppStepEditor, { definition, onChange: () => {} }));
const base = (when?: AppStepCondition): AppDefinition =>
  ({ schemaVersion: 1, fields, output: 'bullets', steps: [{ name: '검토', instruction: '검토하세요.', ...(when ? { when } : {}) }, { name: '작성', instruction: '작성하세요.' }] });

describe('step condition editor', () => {
  it('starts a rule with the first operator of the field type and a valid value only for choices', () => {
    expect(defaultRule(fields[0])).toEqual({ field: 'kind', op: 'equals', value: '안내' });
    expect(defaultRule(fields[1])).toEqual({ field: 'memo', op: 'contains', value: '' });
    expect(defaultRule(fields[2])).toEqual({ field: 'count', op: 'equals', value: '' });
    expect(defaultRule(fields[3])).toEqual({ field: 'due', op: 'equals', value: '' });
    // 목록 선택의 첫 규칙은 그대로 저장할 수 있다 — 글·숫자·날짜는 값을 넣어야 저장된다
    expect(validateAppDefinition(base({ all: [defaultRule(fields[0])] })).ok).toBe(true);
    expect(validateAppDefinition(base({ all: [defaultRule(fields[2])] })).ok).toBe(false);
  });
  it('shows every input field and only the operators of the chosen field type', () => {
    const page = html(base({ all: [{ field: 'count', op: 'gte', value: '30' }, { field: 'memo', op: 'empty' }] }));
    expect(page).toContain('아래 조건이 모두 맞을 때만 실행');
    for (const label of ['종류', '메모', '인원', '마감일']) expect(page).toContain(`>${label}</option>`);
    const countOps = page.match(/aria-label="단계 1 조건 1 비교"[\s\S]*?<\/select>/)![0];
    for (const op of ['같음', '같지 않음', '보다 큼', '이상', '보다 작음', '이하', '입력됨', '비어 있음']) expect(countOps).toContain(`>${op}</option>`);
    expect(countOps).not.toContain('>포함</option>');
    expect(page).toMatch(/aria-label="단계 1 조건 1 값"[^>]*type="number"[^>]*value="30"|type="number"[^>]*aria-label="단계 1 조건 1 값"/);
    expect(page).not.toContain('aria-label="단계 1 조건 2 값"');
    expect(page).toContain('값 없음');
    expect(page).toContain('+ 조건 추가 (그리고)');
  });
  it('hides "add rule" at the limit and marks a rule whose field was removed', () => {
    const full = html(base({ all: [{ field: 'kind', op: 'equals', value: '안내' }, { field: 'memo', op: 'filled' }, { field: 'due', op: 'before', value: '2026-03-01' }] }));
    expect(full).not.toContain('+ 조건 추가');
    const gone = html(base({ all: [{ field: 'deleted', op: 'filled' }] }));
    expect(gone).toContain('삭제된 항목');
  });
  it('keeps the final step unconditional and offers no conditions on an unconditional step', () => {
    const page = html(base());
    expect(page).not.toContain('조건 1 항목');
    expect(page).toMatch(/<option value="when" disabled="">아래 조건이 모두 맞을 때만 실행<\/option>/);
  });
});

describe('step branch editor', () => {
  const branchDef: AppDefinition = { ...base(), steps: [
    { name: '검토', instruction: '검토하세요.', branches: [
      { name: '공지 검토', when: { all: [{ field: 'kind', op: 'equals', value: '공지' }, { field: 'count', op: 'gte', value: '30' }] }, instruction: '공지 기준으로 검토하세요.' },
    ] },
    { name: '작성', instruction: '작성하세요.', branches: [
      { name: '갈래 1', when: { all: [{ field: 'memo', op: 'filled' }] }, instruction: '메모를 반영하세요.' },
      { name: '갈래 2', when: { all: [{ field: 'due', op: 'before', value: '2026-03-01' }] }, instruction: '서둘러 작성하세요.' },
      { name: '갈래 3', when: { all: [{ field: 'kind', op: 'not_equals', value: '안내' }] }, instruction: '그 밖.' },
    ] },
  ] };
  it('renders each branch with its name, rules and instruction, and offers to add a branch below the limit', () => {
    const page = html(branchDef);
    expect(page).toContain('갈래 (선택)');
    expect(page).toMatch(/aria-label="단계 1 갈래 1 이름"[^>]*value="공지 검토"|value="공지 검토"[^>]*aria-label="단계 1 갈래 1 이름"/);
    expect(page).toContain('aria-label="단계 1 갈래 1 조건 1 항목"');
    expect(page).toContain('aria-label="단계 1 갈래 1 조건 2 값"');
    expect(page).toContain('aria-label="단계 1 갈래 1 처리 지시"');
    expect(page).toContain('공지 기준으로 검토하세요.');
    // 단계 1은 갈래 1개라 더할 수 있고, 단계 2는 3개라 더하지 못한다 — '+ 갈래 추가'는 한 번만
    expect(page.match(/\+ 갈래 추가/g)).toHaveLength(1);
    // 마지막 단계도 갈래를 둘 수 있다(조건은 둘 수 없어도)
    expect(page).toContain('aria-label="단계 2 갈래 3 처리 지시"');
    expect(page).toContain('갈래 삭제');
  });
  it('a new branch starts with one rule on the first field and an empty instruction, and the step stays valid once filled', () => {
    expect(defaultBranch(fields, 2)).toEqual({ name: '갈래 2', when: { all: [{ field: 'kind', op: 'equals', value: '안내' }] }, instruction: '' });
    expect(validateAppDefinition({ ...base(), steps: [{ name: '검토', instruction: '검토하세요.', branches: [defaultBranch(fields, 1)] }, { name: '작성', instruction: '작성하세요.' }] }).ok).toBe(false);
    expect(validateAppDefinition({ ...base(), steps: [{ name: '검토', instruction: '검토하세요.', branches: [{ ...defaultBranch(fields, 1), instruction: '안내 기준' }] }, { name: '작성', instruction: '작성하세요.' }] }).ok).toBe(true);
    expect(validateAppDefinition(branchDef)).toMatchObject({ ok: true });
  });
});
