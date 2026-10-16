import { describe, it, expect } from 'vitest';
import { headingLevel, isPlaceholderText, normalizeLabel } from '@/lib/doc-fill/slots';

describe('번호 제목 급', () => {
  it.each([
    ['Ⅱ. 추진 계획', 1], ['1. 사업 개요', 2], ['□ 개요', 2], ['가. 현황', 3], ['○ 추진 방향', 3],
    ['1) 인력', 4], ['- 세부 일정', 4], ['가) 예산', 5], ['(1) 1분기', 6], ['(가) 시범', 7], ['① 대상', 8], ['㉮ 비고', 9],
  ])('%s → %d', (text, level) => expect(headingLevel(text)).toBe(level));

  it('제목이 아닌 것', () => {
    expect(headingLevel('1.5배 증가')).toBeNull();
    expect(headingLevel('○ 사업기간은 2026년 1월부터 12월까지 1년이다.')).toBeNull();
    expect(headingLevel('일반 문장')).toBeNull();
    expect(headingLevel('□')).toBeNull();
  });
});

describe('자리 표시 글자', () => {
  it.each(['', '   ', '○○○', 'OOOO', '(내용)', '○ (내용)', '- (작성)', '내용을 입력하세요'])('"%s"는 빈 자리', (t) =>
    expect(isPlaceholderText(t)).toBe(true));
  it.each(['홍길동', '일시: ○○○', '○ 추진 방향', '해당 없음'])('"%s"는 빈 자리가 아니다', (t) =>
    expect(isPlaceholderText(t)).toBe(false));
});

describe('항목명', () => {
  it('공백·콜론을 다듬고 한 글자씩 띄운 이름을 붙인다', () => {
    expect(normalizeLabel('  회의명 : ')).toBe('회의명');
    expect(normalizeLabel('취    급')).toBe('취급');
    expect(normalizeLabel('기 안 자')).toBe('기안자');
    expect(normalizeLabel('사업 기간')).toBe('사업 기간');
  });
});
