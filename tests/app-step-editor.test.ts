import { describe, expect, it } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import AppStepEditor, { defaultRule } from '@/components/apps/AppStepEditor';
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
