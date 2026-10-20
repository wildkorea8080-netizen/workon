import { describe, it, expect } from 'vitest';
import { columnUnit, normalizeUnit } from '@/lib/table-engine/units';

describe('normalizeUnit', () => {
  it.each([
    ['원', '원'], ['천원', '천원'], ['천 원', '천원'], [' 백 만 원 ', '백만원'], ['억원', '억원'], ['조원', '조원'],
    ['%', '%'], ['명', '명'], ['건', '건'], ['개', '개'], ['개소', '개소'], ['회', '회'], ['톤', '톤'],
    ['kg', 'kg'], ['KG', 'kg'], ['ha', 'ha'], ['㎡', '㎡'], ['천　원', '천원'],
  ])('%s → %s', (raw, out) => expect(normalizeUnit(raw)).toBe(out));

  it.each(['', '  ', '만원', '달러', '천', '단위', '원원', '12원'])('모르는 단위: %j', (raw) => {
    expect(normalizeUnit(raw)).toBeNull();
  });
});

describe('columnUnit', () => {
  it('열 단위: 칸 → 머리글 괄호 → 캡션', () => {
    expect(columnUnit({ columnName: '예산', cells: ['100원', '200원', 300] })).toBe('원');
    expect(columnUnit({ columnName: '예산(천원)', cells: [100] })).toBe('천원');
    expect(columnUnit({ columnName: '예산 (단위: 백만원)', cells: [1] })).toBe('백만원');
    expect(columnUnit({ columnName: '예산', caption: '(단위 : 천 원) <표 2>', cells: [1] })).toBe('천원');
    expect(columnUnit({ columnName: '부서', cells: ['총무과'] })).toBeNull();
  });

  it('칸 표기의 과반이어야 한다 — 같은 수는 과반이 아니다', () => {
    expect(columnUnit({ columnName: '예산(천원)', cells: ['100원', '2천원', 3, 4] })).toBe('천원');
    expect(columnUnit({ columnName: 'x', cells: ['100원', '200원', '3천원'] })).toBe('원');
    expect(columnUnit({ columnName: 'x', cells: ['1원', '2천원'] })).toBeNull();
  });

  it('칸 표기가 머리글·캡션보다 먼저다', () => {
    expect(columnUnit({ columnName: '예산(천원)', caption: '(단위: 억원)', cells: ['1,000원', '2,000원'] })).toBe('원');
  });

  it('머리글 괄호: 전각·대괄호·단위 표기 없이도, 모르는 괄호는 건너뜀', () => {
    expect(columnUnit({ columnName: '예산（천원）', cells: [] })).toBe('천원');
    expect(columnUnit({ columnName: '예산 [백만원]', cells: [] })).toBe('백만원');
    expect(columnUnit({ columnName: '예산 / 본예산(천원)', cells: [] })).toBe('천원');
    expect(columnUnit({ columnName: '비고(참고) (명)', cells: [] })).toBe('명');
    expect(columnUnit({ columnName: '구분(가)', cells: [] })).toBeNull();
  });

  it('캡션: 단위 표기 꼴 여럿, 단위 앞뒤 글', () => {
    expect(columnUnit({ columnName: '예산', caption: '단위 : 천원', cells: [] })).toBe('천원');
    expect(columnUnit({ columnName: '예산', caption: '<표 2> 연도별 예산 (단위: 억원)', cells: [] })).toBe('억원');
    expect(columnUnit({ columnName: '예산', caption: '단위：천 원 연도별 예산', cells: [] })).toBe('천원');
    expect(columnUnit({ columnName: '예산', caption: '연도별 예산', cells: [] })).toBeNull();
  });

  it('캡션에 단위가 여럿이면 어느 열 것인지 알 수 없어 null', () => {
    expect(columnUnit({ columnName: '예산', caption: '(단위: 천원, 명)', cells: [] })).toBeNull();
    expect(columnUnit({ columnName: '예산', caption: '(단위: 천원/명)', cells: [] })).toBeNull();
  });

  it('값이 아닌 칸은 세지 않는다', () => {
    expect(columnUnit({ columnName: 'x', cells: ['미제출', null, '', '100원'] })).toBe('원');
    expect(columnUnit({ columnName: 'x', cells: [null, '-'] })).toBeNull();
  });
});
