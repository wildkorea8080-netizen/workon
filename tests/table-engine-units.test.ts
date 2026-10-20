import { describe, it, expect } from 'vitest';
import { columnUnit, normalizeUnit } from '@/lib/table-engine/units';

describe('normalizeUnit', () => {
  it.each([
    ['원', '원'], ['천원', '천원'], ['천 원', '천원'], [' 백 만 원 ', '백만원'], ['억원', '억원'], ['조원', '조원'],
    ['%', '%'], ['명', '명'], ['건', '건'], ['개', '개'], ['개소', '개소'], ['회', '회'], ['톤', '톤'],
    ['kg', 'kg'], ['KG', 'kg'], ['ha', 'ha'], ['㎡', '㎡'], ['천　원', '천원'],
  ])('%s → %s', (raw, out) => expect(normalizeUnit(raw)).toBe(out));

  it.each([
    ['만원', '만원'], ['천만원', '천만원'], ['십억원', '십억원'], ['백억 원', '백억원'], ['천명', '천명'], ['만 명', '만명'],
    ['천톤', '천톤'], ['천㎡', '천㎡'], ['대', '대'], ['가구', '가구'], ['천가구', '천가구'], ['%p', '%p'], ['km', 'km'],
    ['Km', 'km'], ['KM', 'km'], ['㎞', 'km'], ['㎏', 'kg'], ['㏊', 'ha'], ['㎥', '㎥'], ['일', '일'], ['시간', '시간'],
    ['년', '년'], ['개월', '개월'], ['점', '점'], ['배', '배'], ['억', '억원'], ['조', '조원'],
  ])('합성·별칭 %s → %s', (raw, out) => expect(normalizeUnit(raw)).toBe(out));

  it.each(['', '  ', '달러', '천', '만', '십억', '단위', '원원', '12원', '냥', '억명원'])('모르는 단위: %j', (raw) => {
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
    expect(columnUnit({ columnName: '예산(천원)(명)', cells: [] })).toBeNull(); // 서로 다른 단위 둘
    expect(columnUnit({ columnName: '구분(가)', cells: [] })).toBeNull();
  });

  it('머리글에 단위로 보이는 괄호가 있는데 모르는 단위면 캡션으로 넘어가지 않는다', () => {
    expect(columnUnit({ columnName: '예산(만원)', caption: '(단위: 천원)', cells: [] })).toBe('만원');
    expect(columnUnit({ columnName: '예산(천냥)', caption: '(단위: 천원)', cells: [] })).toBeNull();
    expect(columnUnit({ columnName: '예산(냥원)', caption: '(단위: 천원)', cells: [] })).toBeNull();
    expect(columnUnit({ columnName: '예산(단위: 냥)', caption: '(단위: 천원)', cells: [] })).toBeNull();
    expect(columnUnit({ columnName: '예산(단위 냥)', caption: '(단위: 천원)', cells: [] })).toBeNull();
    // 숫자·긴 글이 든 괄호는 단위로 보지 않는다
    expect(columnUnit({ columnName: '예산(2025년 기준 본예산)', caption: '(단위: 천원)', cells: [] })).toBe('천원');
    expect(columnUnit({ columnName: '예산', caption: '(단위: 천원)', cells: [] })).toBe('천원');
  });

  it('단위 글자가 없는 짧은 괄호는 단위가 아니라 구분 표기라 캡션으로 넘어간다', () => {
    for (const note of ['국비', '시비', '일반', '본예산', '추경', 'A', '전년', '참고', '냥']) {
      expect(columnUnit({ columnName: `예산(${note})`, caption: '(단위: 천원)', cells: [] })).toBe('천원');
    }
    // 단위 글자가 든 괄호는 단위로 보고, 모르는 단위면 멈춘다
    for (const note of ['천냥', '냥원', '십만평', '%x', '5kg대']) {
      expect(columnUnit({ columnName: `예산(${note})`, caption: '(단위: 천원)', cells: [] })).toBeNull();
    }
  });

  it('머리글 괄호가 단위를 나열한 목록이면 캡션으로 넘어가지 않는다', () => {
    for (const name of ['예산(천원, 명)', '예산(천원 / 명)', '예산(백만원/㎡)', '예산(단위: 천원, 명)']) {
      expect(columnUnit({ columnName: name, caption: '(단위: 억원)', cells: [] })).toBeNull();
    }
    // 단위가 하나도 없는 목록은 구분 표기 — 막지 않는다
    expect(columnUnit({ columnName: '예산(국비, 시비)', caption: '(단위: 억원)', cells: [] })).toBe('억원');
  });

  it('캡션 단위가 낱말 둘(억 명)이면 길게 이은 쪽이 먼저다', () => {
    expect(columnUnit({ columnName: 'x', caption: '(단위: 억 명)', cells: [] })).toBe('억명');
    expect(columnUnit({ columnName: 'x', caption: '단위: 억 건', cells: [] })).toBe('억건');
    expect(columnUnit({ columnName: 'x', caption: '(단위: 조 개)', cells: [] })).toBe('조개');
    expect(columnUnit({ columnName: 'x', caption: '(단위: 억)', cells: [] })).toBe('억원');
    expect(columnUnit({ columnName: 'x', caption: '(단위: 억 원)', cells: [] })).toBe('억원');
    expect(columnUnit({ columnName: 'x', caption: '단위: 천 원 연도별 예산', cells: [] })).toBe('천원');
  });

  it('캡션에 단위 절이 둘 이상이면 null, 문장 속 단위는 절이 아니다', () => {
    expect(columnUnit({ columnName: '예산', caption: '(단위: 천원) (단위: 명)', cells: [] })).toBeNull();
    expect(columnUnit({ columnName: '예산', caption: '(단위: 천원) (단위 : 천원)', cells: [] })).toBe('천원');
    expect(columnUnit({ columnName: '예산', caption: '단위 건 처리 현황', cells: [] })).toBeNull();
    expect(columnUnit({ columnName: '예산', caption: '(단위 천원)', cells: [] })).toBe('천원');
    expect(columnUnit({ columnName: '예산', caption: '(단위: 천원) <표 2>', cells: [] })).toBe('천원');
    expect(columnUnit({ columnName: '예산', caption: '(단위: 천원) 단위 건 처리', cells: [] })).toBe('천원');
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
