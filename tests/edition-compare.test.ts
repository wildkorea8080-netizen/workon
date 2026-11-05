import { describe, it, expect } from 'vitest';
import {
  compareEditions,
  splitParagraphs,
  paragraphSimilarity,
  inlineDiff,
  articleHeading,
  EditionCompareError,
  MAX_COMPARE_PARAGRAPHS,
} from '@/lib/edition-compare';

/**
 * 두 판 신구 대비(2026-11-05). 개정된 규정의 어느 조문이 바뀌었는지를 사람이 놓치지 않게 하는 것이 목적이라,
 * 틀린 대조(바뀐 문단을 같다고 하거나, 다른 조문끼리 짝짓기)를 가장 비싼 오류로 본다.
 */

const OLD = [
  '여비 규정',
  '제1조(목적) 이 규정은 출장 여비 지급에 관한 사항을 정한다.',
  '제2조(일비) 일비는 1일 20,000원으로 한다.',
  '제3조(숙박비) 숙박비는 실비로 지급한다.',
  '제4조(식비) 식비는 1일 25,000원으로 한다.',
  '부칙',
  '이 규정은 2025년 1월 1일부터 시행한다.',
].join('\n');

const NEW = [
  '여비 규정',
  '제1조(목적) 이 규정은 출장 여비 지급에 관한 사항을 정한다.',
  '제2조(일비) 일비는 1일 25,000원으로 한다.',
  '제4조(식비) 식비는 1일 25,000원으로 한다.',
  '제5조(교통비) 교통비는 철도 운임을 기준으로 한다.',
  '부칙',
  '이 규정은 2026년 1월 1일부터 시행한다.',
].join('\n');

describe('문단 나누기', () => {
  it('빈 줄을 버리고 공백을 하나로, 보이지 않는 글자를 뺀다', () => {
    expect(splitParagraphs('  가  나\n\n​다\r\n').paragraphs).toEqual(['가 나', '다']);
  });

  it('상한을 넘으면 앞의 것만 맞대고 잘렸다고 알린다', () => {
    const text = Array.from({ length: MAX_COMPARE_PARAGRAPHS + 5 }, (_, i) => `문단 ${i}`).join('\n');
    const r = splitParagraphs(text);
    expect(r.paragraphs).toHaveLength(MAX_COMPARE_PARAGRAPHS);
    expect(r.truncated).toBe(true);
  });
});

describe('조문 제목', () => {
  it('제N조·제N조의M과 괄호 제목을 읽는다', () => {
    expect(articleHeading('제12조(여비) 여비는')).toBe('제12조(여비)');
    expect(articleHeading('제 3 조의 2 (특례) 다만')).toBe('제3조의2(특례)');
    expect(articleHeading('제7조 삭제')).toBe('제7조');
    expect(articleHeading('이 규정 제3조에 따라')).toBeNull();
  });
});

describe('신구 대비', () => {
  const r = compareEditions(OLD, NEW);

  it('고친 문단·지운 문단·새 문단을 가른다', () => {
    expect(r.identical).toBe(false);
    expect(r.stats).toEqual({ same: 4, changed: 2, removed: 1, added: 1 });
  });

  it('고친 문단 안에서는 바뀐 숫자만 칠한다', () => {
    const changed = r.rows.find((x) => x.kind === 'changed' && x.location === '제2조(일비)');
    expect(changed).toBeDefined();
    if (changed?.kind !== 'changed') return;
    expect(changed.old.filter((p) => p.changed).map((p) => p.text)).toEqual(['20']);
    expect(changed.new.filter((p) => p.changed).map((p) => p.text)).toEqual(['25']);
    expect(changed.old.map((p) => p.text).join('')).toBe('제2조(일비) 일비는 1일 20,000원으로 한다.');
  });

  it('지운 조문과 새 조문은 짝짓지 않는다(서로 닮지 않음)', () => {
    const removed = r.rows.find((x) => x.kind === 'removed');
    const added = r.rows.find((x) => x.kind === 'added');
    expect(removed).toMatchObject({ old: '제3조(숙박비) 숙박비는 실비로 지급한다.', location: '제3조(숙박비)' });
    expect(added).toMatchObject({ new: '제5조(교통비) 교통비는 철도 운임을 기준으로 한다.', location: '제5조(교통비)' });
  });

  it('부칙의 시행일 문장은 바로 앞 조문 위치를 이어 받는다', () => {
    const last = r.rows.filter((x) => x.kind === 'changed').at(-1);
    expect(last?.kind === 'changed' && last.new.filter((p) => p.changed).map((p) => p.text)).toEqual(['2026']);
  });

  it('바뀐 곳에서 먼 같은 문단은 접는다', () => {
    const kinds = r.rows.map((x) => x.kind);
    // 맨 앞 '여비 규정'은 제2조 변경에서 두 칸 떨어져 접힌다
    expect(kinds[0]).toBe('skip');
    expect(r.rows[0]).toEqual({ kind: 'skip', count: 1 });
  });

  it('같은 두 글은 언제나 같은 결과다', () => {
    expect(compareEditions(OLD, NEW)).toEqual(r);
  });
});

describe('같은 판', () => {
  it('띄어쓰기만 다르면 같은 판이다', () => {
    const r = compareEditions('제 3 조(숙박비)  숙박비는 실비로\n지급한다.', '제3조(숙박비) 숙박비는 실비로\n\n지급한다.');
    expect(r.identical).toBe(true);
    expect(r.rows).toEqual([]);
    expect(r.stats.same).toBe(2);
  });

  it('글자 하나만 달라도 바뀐 문단이다', () => {
    const r = compareEditions('지급할 수 있다.', '지급하여야 한다.');
    expect(r.identical).toBe(false);
  });
});

describe('짝짓기·낱말 대조', () => {
  it('닮음은 띄어쓰기를 보지 않는다', () => {
    expect(paragraphSimilarity('가 나 다 라', '가나다라')).toBe(1);
    expect(paragraphSimilarity('일비는 1일 20,000원', '일비는 1일 25,000원')).toBeGreaterThan(0.5);
    expect(paragraphSimilarity('숙박비는 실비로 지급한다', '교통비는 철도 운임 기준')).toBeLessThan(0.5);
  });

  it('공백 차이는 바뀐 것으로 칠하지 않는다', () => {
    const d = inlineDiff('가 나', '가  나 다');
    expect(d.old.every((p) => !p.changed)).toBe(true);
    expect(d.new.filter((p) => p.changed).map((p) => p.text)).toEqual(['다']);
  });

  it('너무 긴 문단은 통째로 바뀐 것으로 칠한다', () => {
    const long = Array.from({ length: 700 }, (_, i) => `낱말${i}`).join(' ');
    const d = inlineDiff(long, long + ' 끝');
    expect(d.old).toEqual([{ text: long, changed: true }]);
  });

  it('지운 것과 넣은 것이 여럿이면 순서를 지키며 닮은 것끼리 잇는다', () => {
    const r = compareEditions(
      ['같음', '제1조 사업비는 100만원으로 한다.', '같음2'].join('\n'),
      ['같음', '제1조의2 신설 조문이다.', '제1조 사업비는 200만원으로 한다.', '같음2'].join('\n')
    );
    expect(r.rows.map((x) => x.kind)).toEqual(['same', 'added', 'changed', 'same']);
  });
});

describe('너무 큰 차이', () => {
  it('맞댈 칸이 상한을 넘으면 짐작하지 않고 멈춘다', () => {
    const a = Array.from({ length: 4_000 }, (_, i) => `옛 문단 ${i}`).join('\n');
    const b = Array.from({ length: 4_000 }, (_, i) => `새 문단 ${i}`).join('\n');
    expect(() => compareEditions(a, b)).toThrow(EditionCompareError);
  });

  it('같은 앞·뒤가 길면 가운데만 세어 큰 문서도 맞댄다', () => {
    const body = Array.from({ length: 5_000 }, (_, i) => `제${i + 1}조 내용 ${i}`);
    const changed = [...body];
    changed[2_500] = '제2501조 내용 바뀜';
    const r = compareEditions(body.join('\n'), changed.join('\n'));
    expect(r.stats.changed + r.stats.removed + r.stats.added).toBeGreaterThan(0);
    expect(r.rows.length).toBeLessThan(10);
  });
});
