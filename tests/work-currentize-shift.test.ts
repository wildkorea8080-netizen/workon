// tests/work-currentize-shift.test.ts
import { describe, expect, it } from 'vitest';
import { classifySegment, type ClassifyContext, type Finding } from '@/lib/work/workflows/currentize/classify';
import { dominantYear, shiftYears } from '@/lib/work/workflows/currentize/shift';

const ctx: ClassifyContext = { basisDate: '2026-03-01', regulationNames: [], personNames: [] };

function run(text: string, from = 2025, to = 2026) {
  return shiftYears(text, classifySegment(text, ctx), from, to);
}

describe('shiftYears — 세 꼴 변환', () => {
  it('2025년 → 2026년', () => {
    expect(run('2025년 업무계획')).toEqual({ text: '2026년 업무계획', changed: true });
  });

  it("'25 → '26 (아포스트로피 세 가지)", () => {
    expect(run("'25 하반기").text).toBe("'26 하반기");
    expect(run('’25 하반기').text).toBe('’26 하반기');
    expect(run('‘25 하반기').text).toBe('‘26 하반기');
  });

  it('2025. 1. 1. → 2026. 1. 1. (띄어쓰기 그대로)', () => {
    expect(run('시행일 2025. 1. 1.').text).toBe('시행일 2026. 1. 1.');
    expect(run('시행일 2025.1.1.').text).toBe('시행일 2026.1.1.');
  });

  it('연월만 있는 2025. 3. 도 민다', () => {
    expect(run('2025. 3. 기준 현황').text).toBe('2026. 3. 기준 현황');
  });
});

describe('shiftYears — 바꾸지 않는 것', () => {
  it('전년도·금년도는 글을 바꾸지 않는다', () => {
    const r = run('전년도 대비 금년도 실적');
    expect(r).toEqual({ text: '전년도 대비 금년도 실적', changed: false });
  });

  it('fromYear와 다른 연도는 그대로', () => {
    expect(run('2023년 실적')).toEqual({ text: '2023년 실적', changed: false });
    expect(run("'23 실적").changed).toBe(false);
  });

  it('찾은 것이 없으면 그대로', () => {
    expect(shiftYears('내용 없음', [], 2025, 2026)).toEqual({ text: '내용 없음', changed: false });
  });

  it.each(['2025-123호 문서', '「2025년 제정 조례」 제3조', '2025년부터 3년간 추진'])(
    '예외 %s 는 그대로',
    (text) => {
      expect(run(text)).toEqual({ text, changed: false });
    },
  );

  it('finding 글이 실제 자리와 다르면 건드리지 않는다', () => {
    const bad: Finding[] = [{ kind: 'year', start: 0, end: 5, text: '2025년', }];
    expect(shiftYears('abcdefg', bad, 2025, 2026)).toEqual({ text: 'abcdefg', changed: false });
  });
});

describe('shiftYears — 한 글에 여러 곳', () => {
  it('길이가 같지 않아도 자리가 어긋나지 않는다', () => {
    const r = run("2025년 계획('25) 시행 2025. 1. 1. 전년도 2023년");
    expect(r.text).toBe("2026년 계획('26) 시행 2026. 1. 1. 전년도 2023년");
    expect(r.changed).toBe(true);
  });

  it('fromYear → toYear 가 두 자리 이상 달라도 된다', () => {
    expect(run('2025년 · 2025년', 2025, 2030).text).toBe('2030년 · 2030년');
  });
});

describe('dominantYear', () => {
  const f = (text: string) => classifySegment(text, ctx);

  it('가장 많이 나온 연도', () => {
    expect(dominantYear(f('2024년 2025년 2025. 1. 1. 2023년'))).toBe(2025);
  });

  it('아포스트로피는 2000+yy 로 센다', () => {
    expect(dominantYear(f("'24 '24 2025년"))).toBe(2024);
  });

  it('동률이면 큰 연도', () => {
    expect(dominantYear(f('2024년 2025년'))).toBe(2025);
  });

  it('연도가 없으면 null', () => {
    expect(dominantYear(f('전년도 실적'))).toBeNull();
    expect(dominantYear([])).toBeNull();
  });
});
