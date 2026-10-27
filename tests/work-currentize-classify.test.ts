import { describe, it, expect } from 'vitest';
import { classifySegment, type Finding } from '@/lib/work/workflows/currentize/classify';
import { numberSpans, answerNumbers } from '@/lib/assistant/number-check';

const ctx = {
  basisDate: '2026-10-28',
  regulationNames: ['지방공기업 예산편성기준', '공무원 여비 규정'],
  personNames: ['홍길동', '김민수'],
};

const f = (kind: Finding['kind'], text: string, start: number, detail?: Finding['detail']): Finding => ({
  kind,
  start,
  end: start + text.length,
  text,
  ...(detail ? { detail } : {}),
});

describe('classifySegment — 다섯 꼴', () => {
  it('연도: 2025년 · 어포스트로피 연도 · 연월', () => {
    expect(classifySegment('2025년 사업', ctx)).toEqual([f('year', '2025년', 0)]);
    expect(classifySegment("'25 사업", ctx)).toEqual([f('year', "'25", 0)]);
    expect(classifySegment('2025. 3. 기준', ctx)).toEqual([f('year', '2025. 3.', 0)]);
  });

  it('날짜는 연도가 아니라 date 하나', () => {
    expect(classifySegment('시행일 2025. 1. 1. 부터', ctx)).toEqual([f('date', '2025. 1. 1.', 4)]);
  });

  it('기간: 전년도·금년도·당해연도·올해·작년', () => {
    expect(classifySegment('전년도 대비 올해 증가', ctx)).toEqual([f('period', '전년도', 0), f('period', '올해', 7)]);
    expect(classifySegment('금년도와 당해연도, 작년', ctx).map((x) => x.text)).toEqual(['금년도', '당해연도', '작년']);
  });

  it('수치: 4자리 미만 정수는 제외, 단위는 prose에 남고 토큰만', () => {
    expect(classifySegment('예산은 1,200백만원 이다', ctx)).toEqual([f('number', '1,200', 4)]);
    expect(classifySegment('직원 12명 배치', ctx)).toEqual([]);
    expect(classifySegment('증가율 3.5% 로 확대', ctx)).toEqual([f('number', '3.5', 4)]);
  });

  it('인용: 「」 + 조문 / 목록 이름 + 조문', () => {
    expect(classifySegment('「국가재정법」 제64조에 따라', ctx)).toEqual([
      f('citation', '「국가재정법」 제64조', 0, { name: '국가재정법', article: '제64조' }),
    ]);
    expect(classifySegment('「지방계약법」 제76조의2', ctx)).toEqual([
      f('citation', '「지방계약법」 제76조의2', 0, { name: '지방계약법', article: '제76조의2' }),
    ]);
    expect(classifySegment('「조례」를 따른다', ctx)).toEqual([f('citation', '「조례」', 0, { name: '조례', article: undefined })]);
    expect(classifySegment('공무원 여비 규정 제3조의2 준용', ctx)).toEqual([
      f('citation', '공무원 여비 규정 제3조의2', 0, { name: '공무원 여비 규정', article: '제3조의2' }),
    ]);
    expect(classifySegment('지방공기업 예산편성기준에 따른다', ctx)).toEqual([
      f('citation', '지방공기업 예산편성기준', 0, { name: '지방공기업 예산편성기준', article: undefined }),
    ]);
  });

  it('사람: 목록의 이름만, 다른 낱말 속은 제외', () => {
    expect(classifySegment('담당 홍길동 주무관', ctx)).toEqual([f('person', '홍길동', 3)]);
    expect(classifySegment('홍길동순 김민수', ctx)).toEqual([f('person', '김민수', 5)]);
  });

  it('사람: 조사·호칭이 붙어도 이름만 잡는다', () => {
    expect(classifySegment('담당자 홍길동이 작성', ctx)).toEqual([f('person', '홍길동', 4)]);
    expect(classifySegment('담당자 홍길동은 부재', ctx)).toEqual([f('person', '홍길동', 4)]);
    expect(classifySegment('담당자 홍길동에게 전달', ctx)).toEqual([f('person', '홍길동', 4)]);
    expect(classifySegment('담당자 홍길동씨 확인', ctx)).toEqual([f('person', '홍길동', 4)]);
    expect(classifySegment('담당자 홍길동님께 보고', ctx)).toEqual([f('person', '홍길동', 4)]);
    expect(classifySegment('담당자 홍길동순 확인', ctx).filter((x) => x.kind === 'person')).toEqual([]);
    expect(classifySegment('담당자 홍길동이다 확인', ctx).filter((x) => x.kind === 'person')).toEqual([]);
  });

  it('prose: 10자 이상 + 다른 finding 없음 → 하나', () => {
    const t = '이 사업은 지역 주민의 편의를 위해 추진한다';
    expect(classifySegment(t, ctx)).toEqual([{ kind: 'prose', start: 0, end: t.length, text: t }]);
    expect(classifySegment('짧은 글', ctx)).toEqual([]);
    expect(classifySegment('', ctx)).toEqual([]);
  });

  it('finding이 있으면 prose를 더하지 않고, 겹침 없이 start 순', () => {
    const r = classifySegment('올해 2025년 홍길동 「법」 제1조 1,200원', ctx);
    expect(r.map((x) => x.kind)).toEqual(['period', 'year', 'person', 'citation', 'number']);
    for (let i = 1; i < r.length; i++) expect(r[i].start).toBeGreaterThanOrEqual(r[i - 1].end);
  });
});

describe('classifySegment — 제외 셋 (Review Focus 1)', () => {
  it('문서번호 2025-123호는 연도가 아니다', () => {
    expect(classifySegment('문서번호 2025-123호 참조', ctx).filter((x) => x.kind === 'year')).toEqual([]);
    expect(classifySegment('문서번호 2025-123호 참조', ctx).filter((x) => x.kind !== 'prose')).toEqual([]);
  });

  it('문서번호 2025-1234호는 연도도 수치도 아니다', () => {
    const r = classifySegment('문서번호 2025-1234호 참조', ctx);
    expect(r.filter((x) => x.kind === 'year' || x.kind === 'number')).toEqual([]);
  });

  it('「…」 안의 연도는 연도가 아니다(인용 하나)', () => {
    expect(classifySegment('「2025년 제정 조례」를 본다', ctx)).toEqual([
      f('citation', '「2025년 제정 조례」', 0, { name: '2025년 제정 조례', article: undefined }),
    ]);
  });

  it('2025년부터 3년간: 부터가 뒤따르면 연도가 아니다', () => {
    expect(classifySegment('2025년부터 3년간 추진', ctx).filter((x) => x.kind === 'year')).toEqual([]);
    expect(classifySegment('2025년 부터 시행', ctx).filter((x) => x.kind === 'year')).toEqual([]);
    expect(classifySegment('2025년까지 시행', ctx)).toEqual([f('year', '2025년', 0)]);
  });
});

describe('numberSpans — number-check와 같은 기준 + 위치', () => {
  it('answerNumbers와 같은 토큰을 위치와 함께 낸다', () => {
    const t = '예산 1,200백만원, 12명, 2026년, 3.5% 증가 (1,234)';
    expect(numberSpans(t).map(({ raw, value, decimals }) => ({ raw, value, decimals }))).toEqual(answerNumbers(t));
    for (const s of numberSpans(t)) expect(t.slice(s.start, s.end)).toBe(s.raw);
  });
});
