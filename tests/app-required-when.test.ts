import { describe, expect, it } from 'vitest';
import { createElement } from 'react';
import { readFileSync } from 'fs';
import { renderToStaticMarkup } from 'react-dom/server';
import { describeCondition, fieldRequired, renderAppInput, validateAppDefinition, type AppDefinition, type AppField } from '@/lib/apps/definition';
import AppFields from '@/components/apps/AppFields';
import { RequiredWhenEditor } from '@/components/apps/AppStepEditor';

/** 입력형 앱의 조건부 필수(2026-11-08) — 다른 항목 값에 따라 필수가 되는 항목 */

const kind: AppField = { key: 'kind', label: '종류', type: 'select', required: true, options: ['민원', '질의'] };
const number: AppField = { key: 'case_no', label: '민원 번호', type: 'text', required: false, requiredWhen: { all: [{ field: 'kind', op: 'equals', value: '민원' }] } };
const phone: AppField = { key: 'phone', label: '연락처', type: 'text', required: false };
const mail: AppField = { key: 'mail', label: '이메일', type: 'text', required: false, requiredWhen: { all: [{ field: 'phone', op: 'empty' }] } };
const def = (fields: AppField[]): AppDefinition => ({ schemaVersion: 1, fields, output: 'paragraphs' });
const valid = (fields: unknown[]) => validateAppDefinition({ schemaVersion: 1, fields, output: 'paragraphs' });

describe('조건부 필수 — 저장 검사', () => {
  it('다른 항목을 가리키는 조건은 저장하고, 뒤에 있는 항목도 가리킬 수 있다', () => {
    const saved = valid([number, kind, phone, mail]);
    expect(saved).toMatchObject({ ok: true });
    if (!saved.ok || !saved.value) throw new Error('unreachable');
    expect(saved.value.fields[0].requiredWhen).toEqual({ all: [{ field: 'kind', op: 'equals', value: '민원' }] });
    expect(saved.value.fields[3].requiredWhen).toEqual({ all: [{ field: 'phone', op: 'empty' }] });
    // 조건이 없는 항목에는 칸이 생기지 않는다(옛 앱과 같은 꼴)
    expect('requiredWhen' in saved.value.fields[2]).toBe(false);
    // 또는(OR) 묶음도 된다
    expect(valid([kind, { ...number, requiredWhen: { any: [{ field: 'kind', op: 'equals', value: '민원' }, { field: 'kind', op: 'empty' }] } }]).ok).toBe(true);
  });

  it('자기 자신·없는 항목·분류 결과·맞지 않는 값·늘 필수인 항목은 거절한다', () => {
    const cases: unknown[] = [
      { ...number, requiredWhen: { all: [{ field: 'case_no', op: 'filled' }] } },
      { ...number, requiredWhen: { all: [{ field: 'nope', op: 'filled' }] } },
      { ...number, requiredWhen: { all: [{ field: '@1', op: 'equals', value: '예' }] } },
      { ...number, requiredWhen: { all: [{ field: 'kind', op: 'equals', value: '제안' }] } },
      { ...number, requiredWhen: { all: [] } },
      { ...number, requiredWhen: { all: [{ field: 'kind', op: 'filled' }], any: [{ field: 'kind', op: 'filled' }] } },
      { ...number, requiredWhen: 'kind' },
      { ...number, required: true },
    ];
    for (const bad of cases) {
      const result = valid([kind, bad]);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.message).toContain('민원 번호');
    }
  });
});

describe('조건부 필수 — 입력 검사·판정', () => {
  const app = def([kind, number, phone, mail]);
  it('조건이 맞을 때만 필수 — 실행·예약·연동이 함께 쓰는 renderAppInput', () => {
    const missing = renderAppInput(app, { kind: '민원', phone: '02-1234-5678' });
    expect(missing).toEqual({ ok: false, message: '민원 번호 항목을 입력해 주세요 — 종류: 민원(같음)일 때는 필수입니다.' });
    expect(renderAppInput(app, { kind: '질의', phone: '02-1234-5678' }).ok).toBe(true);
    expect(renderAppInput(app, { kind: '민원', case_no: '2026-1', phone: '02-1234-5678' }).ok).toBe(true);
    // 공백만 적은 값은 비운 것이다 — 조건 쪽에서도, 필수 쪽에서도
    expect(renderAppInput(app, { kind: '질의', phone: '  ' })).toEqual({ ok: false, message: '이메일 항목을 입력해 주세요 — 연락처: 비어 있음일 때는 필수입니다.' });
    expect(renderAppInput(app, { kind: '질의', phone: '', mail: 'a@b.kr' }).ok).toBe(true);
  });
  it('늘 필수 항목의 안내는 그대로, 길이 검사는 필수 판정보다 먼저', () => {
    expect(renderAppInput(app, { phone: '1' })).toEqual({ ok: false, message: '종류 항목을 입력해 주세요.' });
    expect(renderAppInput(app, { kind: '민원', phone: 'x'.repeat(501) })).toEqual({ ok: false, message: '연락처: 입력 길이나 형식을 확인해 주세요.' });
  });
  it('fieldRequired·describeCondition', () => {
    expect(fieldRequired(kind, {})).toBe(true);
    expect(fieldRequired(number, { kind: '민원' })).toBe(true);
    expect(fieldRequired(number, { kind: '질의' })).toBe(false);
    expect(fieldRequired(phone, {})).toBe(false);
    expect(describeCondition({ any: [{ field: 'kind', op: 'equals', value: '민원' }, { field: 'gone', op: 'filled' }] }, [kind])).toBe('종류: 민원(같음) 또는 삭제된 항목: 입력됨');
  });
});

describe('조건부 필수 — 화면', () => {
  it('실행 화면은 지금 값으로 (필수)와 조건 안내를 붙이고 required 속성을 건다', () => {
    const render = (values: Record<string, string>) => renderToStaticMarkup(createElement(AppFields, { definition: def([kind, number]), values, onChange: () => {} }));
    const off = render({ kind: '질의' });
    expect(off).toContain('종류: 민원(같음)일 때 필수');
    expect(off).not.toMatch(/id="app-input-case_no"[^>]*required/);
    const on = render({ kind: '민원' });
    expect(on).toMatch(/민원 번호<span[^>]*>\(필수\)<\/span>/);
    expect(on).toMatch(/id="app-input-case_no"[^>]*required/);
  });
  it('빌더는 늘 필수가 아닌 항목에만 조건 고르기를 보이고, 자기 자신은 고를 수 없다', () => {
    const editor = (field: AppField, fields: AppField[]) => renderToStaticMarkup(createElement(RequiredWhenEditor, { field, fields, onChange: () => {} }));
    expect(editor(kind, [kind, number])).toBe('');
    expect(editor(phone, [phone])).toBe('');
    const page = editor(number, [kind, number]);
    expect(page).toContain('다른 항목에 따라 필수');
    expect(page).toContain('아래 조건이 모두 맞을 때 필수');
    expect(page).toContain('>종류</option>');
    expect(page).not.toContain('>민원 번호</option>');
    const plain = editor(phone, [kind, phone]);
    expect(plain).toContain('다른 항목에 따라 필수');
    expect(plain).not.toContain('아래 조건이 모두 맞을 때 필수');
  });
  it('빌더가 항목 카드에 붙이고, 필수 입력을 켜면 조건부 필수를 지운다', () => {
    const page = readFileSync('src/app/apps/builder/page.tsx', 'utf8');
    expect(page).toContain('<RequiredWhenEditor field={field} fields={definition.fields}');
    expect(page).toContain('...(e.target.checked ? { requiredWhen: undefined } : {})');
  });
});
