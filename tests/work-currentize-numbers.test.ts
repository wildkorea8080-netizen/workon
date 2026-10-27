// tests/work-currentize-numbers.test.ts
import { describe, expect, it } from 'vitest';
import type { Cell, ExtractedTable } from '@/lib/attachments/types';
import { classifySegment } from '@/lib/work/workflows/currentize/classify';
import type { Finding } from '@/lib/work/workflows/currentize/classify';
import { matchRowValues, proseNumberStatus, thisYearColumnValues, unknownProseNumbers } from '@/lib/work/workflows/currentize/numbers';
import type { Segment } from '@/lib/work/workflows/currentize/segments';

function makeTable(id: string, columns: string[], body: Cell[][], caption?: string): ExtractedTable {
  return {
    id,
    title: id,
    cells: [columns, ...body],
    merges: [],
    header: { from: 0, to: 0 },
    columns,
    ...(caption ? { caption } : {}),
  };
}

const PRIOR_COLS = ['구분', '2024년(천원)', '2025년(천원)', '증감'];

describe('matchRowValues', () => {
  it('행 머리가 양쪽에 있으면 올해 값, 없으면 null (여러 표에 걸쳐 찾는다)', () => {
    const prior = makeTable('p', PRIOR_COLS, [
      ['사업 A', 1000, 1200, 200],
      ['사업 B', 500, 600, 100],
      ['사업 C', 300, 350, 50],
    ]);
    const d1 = makeTable('t1', ['사업', '2026년(천원)'], [['사업 A', 1300]]);
    const d2 = makeTable('t2', ['사업', '2026년(천원)'], [['사업 B', 640]]);
    const { values, warnings } = matchRowValues(prior, [d1, d2], '2025년(천원)');
    expect(values.get(1)).toBe(1300);
    expect(values.get(2)).toBe(640);
    expect(values.get(3)).toBeNull();
    expect(warnings).toEqual([]);
  });

  it('보이지 않는 글자·공백이 달라도 맞춘다 (normalizeName, 이어서 squash)', () => {
    const prior = makeTable('p', PRIOR_COLS, [
      ['사업​  A', 1, 2, 1],
      ['총무 과', 1, 2, 1],
    ]);
    const d = makeTable('t1', ['사업', '2026년'], [['사업 A', 10], ['총무과', 20]]);
    const { values } = matchRowValues(prior, [d], '2025년(천원)');
    expect(values.get(1)).toBe(10);
    expect(values.get(2)).toBe(20);
  });

  it('같은 행 머리가 올해 자료에 둘이면 null (추측하지 않는다)', () => {
    const prior = makeTable('p', PRIOR_COLS, [['사업 A', 1, 2, 1]]);
    const d = makeTable('t1', ['사업', '2026년'], [['사업 A', 10], ['사업 A', 20]]);
    expect(matchRowValues(prior, [d], '2025년(천원)').values.get(1)).toBeNull();
    // 표 둘에 하나씩 있어도 마찬가지
    const d2 = makeTable('t2', ['사업', '2026년'], [['사업 A', 10]]);
    const d3 = makeTable('t3', ['사업', '2026년'], [['사업 A', 30]]);
    expect(matchRowValues(prior, [d2, d3], '2025년(천원)').values.get(1)).toBeNull();
  });

  it('합계 낱말 행은 맞추지 않는다', () => {
    const prior = makeTable('p', PRIOR_COLS, [
      ['사업 A', 1, 2, 1],
      ['소 계', 1, 2, 1],
      ['합계', 1, 2, 1],
    ]);
    const d = makeTable('t1', ['사업', '2026년'], [['사업 A', 10], ['소계', 99], ['합계', 99]]);
    const { values } = matchRowValues(prior, [d], '2025년(천원)');
    expect(values.get(1)).toBe(10);
    expect(values.get(2)).toBeNull();
    expect(values.get(3)).toBeNull();
  });

  it('원 → 천원 단위를 맞춰 옮긴다 (열 이름 괄호 단위)', () => {
    const prior = makeTable('p', PRIOR_COLS, [['사업 A', 1000, 1200, 200]]);
    const d = makeTable('t1', ['사업', '2026년(원)'], [['사업 A', 1300000]]);
    const { values, warnings } = matchRowValues(prior, [d], '2025년(천원)');
    expect(values.get(1)).toBe(1300);
    expect(warnings).toEqual([]);
  });

  it('캡션 단위도 읽는다 (백만원 → 천원은 곱한다)', () => {
    const prior = makeTable('p', PRIOR_COLS, [['사업 A', 1000, 1200, 200]]);
    const d = makeTable('t1', ['사업', '2026년'], [['사업 A', 1.5]], '(단위: 백만원)');
    expect(matchRowValues(prior, [d], '2025년(천원)').values.get(1)).toBe(1500);
  });

  it('차원이 다르면(원 ↔ 명) null', () => {
    const prior = makeTable('p', PRIOR_COLS, [['사업 A', 1000, 1200, 200]]);
    const d = makeTable('t1', ['사업', '2026년(명)'], [['사업 A', 40]]);
    expect(matchRowValues(prior, [d], '2025년(천원)').values.get(1)).toBeNull();
  });

  it('한쪽 단위만 알면 그대로 넣고 경고한다', () => {
    const prior = makeTable('p', PRIOR_COLS, [['사업 A', 1000, 1200, 200]]);
    const d = makeTable('t1', ['사업', '2026년'], [['사업 A', 1300]]);
    const { values, warnings } = matchRowValues(prior, [d], '2025년(천원)');
    expect(values.get(1)).toBe(1300);
    expect(warnings).toEqual(['올해 자료의 단위를 알 수 없어 그대로 넣었습니다: 표 t1']);
  });

  it('올해 열이 여럿이면 그 표는 쓰지 않는다', () => {
    const prior = makeTable('p', PRIOR_COLS, [['사업 A', 1000, 1200, 200]]);
    const d = makeTable('t1', ['사업', '2026년 본예산(천원)', '2026년 추경(천원)'], [['사업 A', 1, 2]]);
    const { values, warnings } = matchRowValues(prior, [d], '2025년(천원)');
    expect(values.get(1)).toBeNull();
    expect(warnings.length).toBe(1);
  });

  it('연도 열이 없으면 키 열이 아닌 첫 숫자 열을 쓴다', () => {
    const prior = makeTable('p', PRIOR_COLS, [['사업 A', 1000, 1200, 200]]);
    const d = makeTable('t1', ['사업', '순번', '예산액(천원)'], [['사업 A', 7, 1300]]);
    // 순번이 사업 앞이 아니라 뒤에 있어 행 머리는 '사업 A'
    expect(matchRowValues(prior, [d], '2025년(천원)').values.get(1)).toBe(1300);
  });

  it('읽지 못한 칸은 0이 아니라 null', () => {
    const prior = makeTable('p', PRIOR_COLS, [['사업 A', 1000, 1200, 200]]);
    const d = makeTable('t1', ['사업', '2026년(천원)'], [['사업 A', '미정']]);
    expect(matchRowValues(prior, [d], '2025년(천원)').values.get(1)).toBeNull();
  });

  it('올해 열 없이 지난해 열만 있는 표는 쓰지 않는다 (옛 수치를 올해 것으로 넣지 않는다)', () => {
    const prior = makeTable('p', PRIOR_COLS, [['사업 A', 1000, 1200, 200]]);
    const d = makeTable('t1', ['사업', '2024년(천원)', '2025년(천원)'], [['사업 A', 1000, 1200]]);
    const { values, warnings } = matchRowValues(prior, [d], '2025년(천원)');
    expect(values.get(1)).toBeNull();
    expect(warnings).toEqual(['표 t1에 올해(2026년) 열이 없습니다']);
  });

  it('쓰지 않는 표에 같은 행 머리가 있으면 유일하지 않다 (null)', () => {
    const prior = makeTable('p', PRIOR_COLS, [['사업 A', 1000, 1200, 200]]);
    const ok = makeTable('t1', ['사업', '2026년(천원)'], [['사업 A', 1300]]);
    const rejected = makeTable('t2', ['사업', '2025년(천원)'], [['사업 A', 1200]]);
    expect(matchRowValues(prior, [ok, rejected], '2025년(천원)').values.get(1)).toBeNull();
  });

  it('단위를 모르는 열에서 온 값은 uncertain (한쪽만 모르거나 둘 다 모르거나)', () => {
    const known = makeTable('p', PRIOR_COLS, [['사업 A', 1000, 1200, 200], ['사업 B', 1, 2, 1]]);
    const d = makeTable('t1', ['사업', '2026년'], [['사업 A', 1300], ['사업 B', 3]]);
    const one = matchRowValues(known, [d], '2025년(천원)');
    expect([...one.uncertain].sort()).toEqual([1, 2]);

    const unitless = makeTable('p', ['구분', '2024년', '2025년', '증감'], [['사업 A', 1000, 1200, 200]]);
    const both = matchRowValues(unitless, [d], '2025년');
    expect(both.values.get(1)).toBe(1300);
    expect([...both.uncertain]).toEqual([1]);
    expect(both.warnings).toEqual(['작년 표와 올해 자료 모두 단위를 알 수 없어 그대로 넣었습니다: 표 t1']);

    // 작년 단위 모름 / 올해 단위 앎
    const dKnown = makeTable('t1', ['사업', '2026년(천원)'], [['사업 A', 1300]]);
    const prior = matchRowValues(unitless, [dKnown], '2025년');
    expect(prior.values.get(1)).toBe(1300);
    expect([...prior.uncertain]).toEqual([1]);
    expect(prior.warnings).toEqual(['작년 표의 단위를 알 수 없어 그대로 넣었습니다: 표 t1']);
  });

  it('단위를 아는 행은 uncertain이 아니다', () => {
    const prior = makeTable('p', PRIOR_COLS, [['사업 A', 1000, 1200, 200]]);
    const d = makeTable('t1', ['사업', '2026년(원)'], [['사업 A', 1300000]]);
    expect(matchRowValues(prior, [d], '2025년(천원)').uncertain.size).toBe(0);
  });

  it('작년 표에 당해 열 이름이 없으면 전부 null + 경고', () => {
    const prior = makeTable('p', PRIOR_COLS, [['사업 A', 1000, 1200, 200]]);
    const d = makeTable('t1', ['사업', '2026년(천원)'], [['사업 A', 1300]]);
    const { values, warnings } = matchRowValues(prior, [d], '2030년');
    expect(values.get(1)).toBeNull();
    expect(warnings.length).toBe(1);
  });

  it('괄호로 적힌 올해 값은 음수인지 몰라 null', () => {
    const prior = makeTable('p', PRIOR_COLS, [['사업 A', 1000, 1200, 200]]);
    const d = makeTable('t1', ['사업', '2026년(천원)'], [['사업 A', '(1,300)']]);
    expect(matchRowValues(prior, [d], '2025년(천원)').values.get(1)).toBeNull();
  });
});

const SEG: Segment = { id: '0:0', section: 0, text: '', path: [], nested: false, cell: null };
const CTX = { basisDate: '2026-10-28', regulationNames: [], personNames: [] };

function status(text: string, known: number[]) {
  return proseNumberStatus({ ...SEG, text }, classifySegment(text, CTX), new Set(known));
}

describe('proseNumberStatus', () => {
  it('본문 수치가 올해 값에 없으면 needs_check (표만 바뀌고 본문 1,200이 남은 경우)', () => {
    expect(status('사업비는 1,200백만원이다.', [1300])).toBe('needs_check');
  });

  it('올해 값에 있으면 ok', () => {
    expect(status('사업비는 1,200백만원이다.', [1200])).toBe('ok');
  });

  it('수치가 없는 조각은 ok', () => {
    expect(status('총무과에서 처리한다.', [1300])).toBe('ok');
  });

  it('절댓값으로 비교한다 (△는 부호)', () => {
    expect(status('전년 대비 △1,200 감소', [1200])).toBe('ok');
  });

  it('큰 금액은 1 차이도 같은 수가 아니다 (절대 오차)', () => {
    expect(status('사업비는 1,234,567,890원이다.', [1234567891])).toBe('needs_check');
    expect(status('사업비는 1,234,567,891원이다.', [1234567891])).toBe('ok');
  });

  it('수치가 여럿이면 하나만 몰라도 needs_check', () => {
    expect(status('A는 1,200백만원, B는 3,400백만원이다.', [1200, 3400])).toBe('ok');
    expect(status('A는 1,200백만원, B는 3,400백만원이다.', [1200])).toBe('needs_check');
  });

  it('읽지 못한 수치 조각은 needs_check', () => {
    const finding: Finding = { kind: 'number', start: 0, end: 3, text: '007' };
    expect(proseNumberStatus(SEG, [finding], new Set([7]))).toBe('needs_check');
  });
});

describe('unknownProseNumbers·thisYearColumnValues (C2)', () => {
  it('확인되지 않은 수치를 글 그대로 낸다 — 850백만원·35명·85%도 수치다', () => {
    const text = '예산 850백만원, 인원 35명, 달성률 85%';
    expect(unknownProseNumbers(classifySegment(text, CTX), new Set([35]))).toEqual(['850', '85']);
    expect(unknownProseNumbers(classifySegment(text, CTX), new Set([850, 35, 85]))).toEqual([]);
  });

  it('올해 값 열만 — 같은 표의 작년 열·키 열 숫자는 넣지 않는다', () => {
    const t = makeTable('t1', ['구분', '2025년', '2026년'], [['사업 A', '1,200', '1,300'], ['사업 B', 500, 600]]);
    expect(thisYearColumnValues([t], 2026).sort((a, b) => a - b)).toEqual([600, 1300]);
    // 올해 머리글이 없으면 다른 해 머리글이 아닌 첫 값 열
    const plain = makeTable('t2', ['연번', '구분', '예산'], [[1, '사업 A', 900]]);
    expect(thisYearColumnValues([plain], 2026)).toEqual([900]);
    // 작년 열만 있으면 아무것도 내지 않는다
    const old = makeTable('t3', ['구분', '2025년'], [['사업 A', 1200]]);
    expect(thisYearColumnValues([old], 2026)).toEqual([]);
  });
});
