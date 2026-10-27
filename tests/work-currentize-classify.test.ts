import { describe, it, expect } from 'vitest';
import { classifySegment, currentizeNumberSpans, type Finding } from '@/lib/work/workflows/currentize/classify';
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

  it('수치: 단위는 prose에 남고 토큰만 — 4자리 미만도 수치다(현행화 전용 판정)', () => {
    expect(classifySegment('예산은 1,200백만원 이다', ctx)).toEqual([f('number', '1,200', 4)]);
    expect(classifySegment('직원 12명 배치', ctx)).toEqual([f('number', '12', 3)]);
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

describe('currentizeNumberSpans — 현행화 수치 판정(C1)', () => {
  const nums = (t: string) => currentizeNumberSpans(t).map((n) => n.raw);
  it('단위·%·%p가 붙었거나 정수 두 자리 이상이면 수치', () => {
    expect(nums('예산 850백만원')).toEqual(['850']);
    expect(nums('직원 35명')).toEqual(['35']);
    expect(nums('달성률 85%')).toEqual(['85']);
    expect(nums('달성률 85 ％')).toEqual(['85']);
    expect(nums('0.3%p 상승')).toEqual(['0.3']);
    expect(nums('3명 배치')).toEqual(['3']);
    expect(nums('1.5배 확대')).toEqual(['1.5']);
    expect(nums('사업 12개소')).toEqual(['12']);
    expect(nums('총 48 과제')).toEqual(['48']);
    // 한 자리 수에 단위가 없으면 수치가 아니다
    expect(nums('1단계 사업')).toEqual([]);
    // 공백 뒤 단위 글자로 시작하는 다른 낱말은 단위가 아니다
    expect(nums('그중 2 일반 과제')).toEqual([]);
  });
  it('자리(start·end)가 글 그대로', () => {
    const t = '예산은 850백만원, 인원 35명, 달성률 85%이다';
    for (const n of currentizeNumberSpans(t)) expect(t.slice(n.start, n.end)).toBe(n.raw);
    expect(currentizeNumberSpans(t).map((n) => n.raw)).toEqual(['850', '35', '85']);
  });
  it('제목 번호·조문·날짜·문서번호·연도·「」 안은 수치가 아니다', () => {
    expect(nums('1. 개요')).toEqual([]);
    expect(nums('12. 추진 일정')).toEqual([]);
    expect(nums('(10) 세부 과제')).toEqual([]);
    expect(nums('「지방공기업법」 제64조제1항제2호에 따라')).toEqual([]);
    expect(nums('제3조의2 준용')).toEqual([]);
    expect(nums('문서번호 2025-123호')).toEqual([]);
    expect(nums('2025. 1. 1. 시행')).toEqual([]);
    expect(nums('2025-01-01 시행')).toEqual([]);
    expect(nums('10월 3일 개최')).toEqual([]);
    expect(nums('12월까지')).toEqual([]);
    expect(nums('10:30 회의')).toEqual([]);
    expect(nums('2025년부터 추진')).toEqual([]);
    expect(nums("'25 사업")).toEqual([]);
    expect(nums('2025 예산')).toEqual([]);
    expect(nums('「2024년 개정 12개 조례」')).toEqual([]);
    expect(nums('표 a12 참조')).toEqual([]);
  });
  it('분류에서도 같은 판정 — 850백만원·35명·85%는 number, 제목·조문·문서번호는 아님', () => {
    expect(classifySegment('예산 850백만원, 35명, 85% 달성', ctx).filter((x) => x.kind === 'number').map((x) => x.text)).toEqual(['850', '35', '85']);
    expect(classifySegment('1. 추진 배경과 필요성 검토', ctx).filter((x) => x.kind === 'number')).toEqual([]);
    expect(classifySegment('「국가재정법」 제64조에 따라 편성', ctx).filter((x) => x.kind === 'number')).toEqual([]);
    expect(classifySegment('문서번호 2025-123호 참조', ctx).filter((x) => x.kind === 'number')).toEqual([]);
  });
});

describe('numberSpans — number-check와 같은 기준 + 위치', () => {
  it('answerNumbers와 같은 토큰을 위치와 함께 낸다', () => {
    const t = '예산 1,200백만원, 12명, 2026년, 3.5% 증가 (1,234)';
    expect(numberSpans(t).map(({ raw, value, decimals }) => ({ raw, value, decimals }))).toEqual(answerNumbers(t));
    for (const s of numberSpans(t)) expect(t.slice(s.start, s.end)).toBe(s.raw);
  });
});
