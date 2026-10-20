import { describe, it, expect } from 'vitest';
import { parseNumber } from '@/lib/table-engine/number';

describe('parseNumber — 값으로 읽히는 꼴', () => {
  it.each([
    ['1,234', 1234], ['1234', 1234], ['1,234.5', 1234.5], [1234, 1234], [0, 0], [-5.5, -5.5],
    ['△1,234', -1234], ['▲ 50', -50], ['-1,234', -1234], ['(1,234)', -1234],
    ['−7', -7], ['0', 0], ['0.5', 0.5], ['  1,234  ', 1234], ['　1,234　', 1234],
  ])('%s → %s', (cell, value) => {
    expect(parseNumber(cell)).toMatchObject({ kind: 'number', value });
  });

  it('만 단위·억 단위·인원·면적 같은 합성 단위', () => {
    expect(parseNumber('1,234만원')).toEqual({ kind: 'number', value: 1234, unit: '만원' });
    expect(parseNumber('25억')).toEqual({ kind: 'number', value: 25, unit: '억원' });
    expect(parseNumber('500천명')).toEqual({ kind: 'number', value: 500, unit: '천명' });
    expect(parseNumber('3,000천㎡')).toEqual({ kind: 'number', value: 3000, unit: '천㎡' });
    expect(parseNumber('12천톤')).toEqual({ kind: 'number', value: 12, unit: '천톤' });
    expect(parseNumber('5㎏')).toEqual({ kind: 'number', value: 5, unit: 'kg' });
    expect(parseNumber('5대')).toEqual({ kind: 'number', value: 5, unit: '대' });
    expect(parseNumber('100가구')).toEqual({ kind: 'number', value: 100, unit: '가구' });
    expect(parseNumber('3.5%p')).toEqual({ kind: 'number', value: 3.5, unit: '%p' });
    expect(parseNumber('7 Km')).toEqual({ kind: 'number', value: 7, unit: 'km' });
  });

  it('괄호 음수는 표시를 남긴다 — 괄호가 음수가 아니라 부연일 수도 있어 경고의 근거가 된다', () => {
    expect(parseNumber('(1,234)')).toEqual({ kind: 'number', value: -1234, parenthesized: true });
    expect(parseNumber('△1,234')).not.toHaveProperty('parenthesized');
    expect(parseNumber('1,234')).not.toHaveProperty('parenthesized');
  });

  it('전각 마이너스 부호', () => {
    expect(parseNumber('－1,234')).toEqual({ kind: 'number', value: -1234 });
    expect(parseNumber('－ 5')).toEqual({ kind: 'number', value: -5 });
  });

  it('음의 0은 0으로 둔다', () => {
    const p = parseNumber('△0');
    expect(p.kind === 'number' && Object.is(p.value, 0)).toBe(true);
  });

  it('단위가 붙은 칸', () => {
    expect(parseNumber('1,234원')).toEqual({ kind: 'number', value: 1234, unit: '원' });
    expect(parseNumber('1,234 천원')).toEqual({ kind: 'number', value: 1234, unit: '천원' });
    expect(parseNumber('1,234 천 원')).toEqual({ kind: 'number', value: 1234, unit: '천원' });
    expect(parseNumber('₩1,234')).toEqual({ kind: 'number', value: 1234, unit: '원' });
    expect(parseNumber('12.5%')).toEqual({ kind: 'number', value: 12.5, unit: '%', percent: true });
    expect(parseNumber('△12.5 %')).toEqual({ kind: 'number', value: -12.5, unit: '%', percent: true });
    expect(parseNumber('3개소')).toEqual({ kind: 'number', value: 3, unit: '개소' });
    expect(parseNumber('2,000톤')).toEqual({ kind: 'number', value: 2000, unit: '톤' });
    expect(parseNumber('10.5ha')).toEqual({ kind: 'number', value: 10.5, unit: 'ha' });
    expect(parseNumber('300㎡')).toEqual({ kind: 'number', value: 300, unit: '㎡' });
  });

  it('부호와 단위가 겹친 꼴', () => {
    expect(parseNumber('(1,234)원')).toEqual({ kind: 'number', value: -1234, unit: '원', parenthesized: true });
    expect(parseNumber('(1,234원)')).toEqual({ kind: 'number', value: -1234, unit: '원', parenthesized: true });
    expect(parseNumber('△₩1,234')).toEqual({ kind: 'number', value: -1234, unit: '원' });
    expect(parseNumber('-₩1,234')).toEqual({ kind: 'number', value: -1234, unit: '원' });
    expect(parseNumber('△1,234천원')).toEqual({ kind: 'number', value: -1234, unit: '천원' });
  });
});

describe('parseNumber — 빈 값', () => {
  it.each([null, '', '  ', '　', '-', '—', '–', ' - ', '－', '―', '‐', '−', '‑', '‒'])('빈 값: %j', (c) => {
    expect(parseNumber(c)).toEqual({ kind: 'empty' });
  });
});

describe('parseNumber — 읽지 못함(0이 아님)', () => {
  it.each([
    '미제출', '해당없음', '1,2,3', '1.2.3', '12ab', '1,23', '1234,567', '.5', '5.', '--5', '△-5', '△(5)',
    '((5))', '(5', '5)', '원', '₩', '₩원', '1원2원', '1,234₩', '1,234냥', '12e3', '0x10', '+5', '１２３',
    '1 234', '007', '00', '0,123', '00,123', '1,234원천원', '₩1,234원', '(1,234원)원', 'NaN', 'Infinity', '12345678901234567890',
  ])('%s', (c) => {
    expect(parseNumber(c)).toEqual({ kind: 'unreadable', text: c });
  });

  it('숫자 형이어도 유한하지 않으면 읽지 못함', () => {
    expect(parseNumber(NaN).kind).toBe('unreadable');
    expect(parseNumber(Infinity).kind).toBe('unreadable');
  });
});
