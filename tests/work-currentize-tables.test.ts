// tests/work-currentize-tables.test.ts
import { describe, expect, it } from 'vitest';
import type { Cell, ExtractedTable, TableMerge } from '@/lib/attachments/types';
import { planColumnShift, shiftColumns } from '@/lib/work/workflows/currentize/tables';

function makeTable(columns: string[], body: Cell[][], merges: TableMerge[] = []): ExtractedTable {
  return {
    id: 't1',
    title: '표 1',
    cells: [columns, ...body],
    merges,
    header: { from: 0, to: 0 },
    columns,
  };
}

const HEAD = ['구분', '2024년', '2025년', '증감', '증감률'];

function at<T extends { row: number; col: number }>(cells: T[], row: number, col: number): T | undefined {
  return cells.find((c) => c.row === row && c.col === col);
}

describe('planColumnShift', () => {
  it('전년도·당해·증감·증감률 열을 찾는다 (toYear 2026)', () => {
    const t = makeTable(HEAD, [['총무과', '1,100', '1,200', '100', '9.09']]);
    expect(planColumnShift(t, 2026)).toEqual({
      prevCol: 1,
      curCol: 2,
      diffCols: [
        { col: 3, kind: 'diff' },
        { col: 4, kind: 'rate' },
      ],
    });
  });

  it('증감 열이 없어도 연도 열 둘이면 계획이 선다 (diffCols 빈 배열)', () => {
    const t = makeTable(['구분', '2024', '2025'], [['A', 1, 2]]);
    expect(planColumnShift(t, 2026)).toEqual({ prevCol: 1, curCol: 2, diffCols: [] });
  });

  it('여러 머리글 꼴을 연도로 읽는다 (2025년도, 2025년(안), ’25)', () => {
    const t = makeTable(['구분', "'24", '2025년(안)', '증감률'], []);
    expect(planColumnShift(t, 2026)).toEqual({ prevCol: 1, curCol: 2, diffCols: [{ col: 3, kind: 'rate' }] });
    const t2 = makeTable(['구분', '2024년도', '’25', '전년 대비 차이'], []);
    expect(planColumnShift(t2, 2026)).toEqual({ prevCol: 1, curCol: 2, diffCols: [{ col: 3, kind: 'diff' }] });
  });

  it('이름에 %·%p가 있으면 증감 낱말이 있어도 rate (금액 증감을 써 넣지 않는다)', () => {
    const t = makeTable(['구분', '2024', '2025', '전년대비 증감(%)', '증감 (%p)', '대비(％)'], []);
    expect(planColumnShift(t, 2026)?.diffCols).toEqual([
      { col: 3, kind: 'rate' },
      { col: 4, kind: 'rate' },
      { col: 5, kind: 'rate' },
    ]);
  });

  it('비율·구성비·비중·점유율 열은 check, 증감 낱말이 함께 있으면 rate', () => {
    const t = makeTable(['구분', '2024', '2025', '구성비율', '비중', '점유율', '증감비율', '전년대비 비율'], []);
    expect(planColumnShift(t, 2026)?.diffCols).toEqual([
      { col: 3, kind: 'check' },
      { col: 4, kind: 'check' },
      { col: 5, kind: 'check' },
      { col: 6, kind: 'rate' },
      { col: 7, kind: 'rate' },
    ]);
  });

  it('연도 열이 하나뿐이면 null', () => {
    const t = makeTable(['구분', '2025년', '증감'], [['A', 1, 2]]);
    expect(planColumnShift(t, 2026)).toBeNull();
  });

  it('연도가 toYear−2 / toYear−1 짝이 아니면 null (2020 | 2025)', () => {
    const t = makeTable(['구분', '2020', '2025', '증감'], [['A', 1, 2, 1]]);
    expect(planColumnShift(t, 2026)).toBeNull();
  });

  it('월·분기나 연도 둘이 든 머리글은 연도 열로 보지 않는다', () => {
    expect(planColumnShift(makeTable(['구분', '3월', '1분기'], []), 2026)).toBeNull();
    expect(planColumnShift(makeTable(['구분', '2024', '2025년 대비 2024년'], []), 2026)).toBeNull();
  });

  it('같은 연도 열이 둘이면 어느 쪽인지 몰라 null', () => {
    const t = makeTable(['구분', '2024', '예산 2025', '결산 2025'], []);
    expect(planColumnShift(t, 2026)).toBeNull();
  });

  it('여러 줄 머리글은 columns의 이어 붙인 이름으로 찾는다', () => {
    const t: ExtractedTable = {
      id: 't1',
      title: '표 1',
      cells: [
        ['구분', '예산', null, '증감'],
        [null, '2024', '2025', null],
        ['A', 10, 20, 10],
      ],
      merges: [{ row: 0, col: 1, rows: 1, cols: 2 }],
      header: { from: 0, to: 1 },
      columns: ['구분', '예산 / 2024', '예산 / 2025', '증감'],
    };
    expect(planColumnShift(t, 2026)).toEqual({ prevCol: 1, curCol: 2, diffCols: [{ col: 3, kind: 'diff' }] });
  });

  it('columns가 비어 있으면 머리글 칸을 이어 붙여 찾는다', () => {
    const t: ExtractedTable = {
      id: 't1',
      title: '표 1',
      cells: [['구분', '2024', '2025'], ['A', 1, 2]],
      merges: [],
      header: { from: 0, to: 0 },
      columns: [],
    };
    expect(planColumnShift(t, 2026)).toEqual({ prevCol: 1, curCol: 2, diffCols: [] });
  });
});

describe('shiftColumns', () => {
  const plan = { prevCol: 1, curCol: 2, diffCols: [{ col: 3, kind: 'diff' as const }, { col: 4, kind: 'rate' as const }] };

  it('전년도 ← 옛 당해, 당해 ← 새 값, 증감·증감률 재계산', () => {
    const t = makeTable(HEAD, [['총무과', '1,100', '1,200', '100', '9.09']]);
    const { cells } = shiftColumns(t, plan, new Map([[1, 1300]]));
    expect(at(cells, 1, 1)).toEqual({ row: 1, col: 1, before: '1,100', after: '1,200', status: 'changed' });
    expect(at(cells, 1, 2)).toEqual({ row: 1, col: 2, before: '1,200', after: '1,300', status: 'changed' });
    expect(at(cells, 1, 3)).toEqual({ row: 1, col: 3, before: '100', after: '100', status: 'changed' });
    expect(at(cells, 1, 4)).toEqual({ row: 1, col: 4, before: '9.09', after: '8.33', status: 'changed' });
    expect(cells).toHaveLength(4);
  });

  it('새 값이 없는 행의 당해·증감 열은 needs_check (전년도 밀기는 그대로)', () => {
    const t = makeTable(HEAD, [['총무과', '1,100', '1,200', '100', '9.09']]);
    const { cells } = shiftColumns(t, plan, new Map());
    expect(at(cells, 1, 1)?.status).toBe('changed');
    expect(at(cells, 1, 2)).toEqual({ row: 1, col: 2, before: '1,200', after: null, status: 'needs_check' });
    expect(at(cells, 1, 3)).toEqual({ row: 1, col: 3, before: '100', after: null, status: 'needs_check' });
    expect(at(cells, 1, 4)).toEqual({ row: 1, col: 4, before: '9.09', after: null, status: 'needs_check' });
  });

  it('새 값이 null이어도 needs_check', () => {
    const t = makeTable(HEAD, [['A', 1, 2, 1, 50]]);
    const { cells } = shiftColumns(t, plan, new Map([[1, null]]));
    expect(at(cells, 1, 2)?.status).toBe('needs_check');
    expect(at(cells, 1, 4)?.status).toBe('needs_check');
  });

  it('prev(옛 당해)가 0이면 증감은 계산하고 증감률만 needs_check', () => {
    const t = makeTable(HEAD, [['A', 5, 0, 0, '-']]);
    const { cells } = shiftColumns(t, plan, new Map([[1, 30]]));
    expect(at(cells, 1, 3)).toEqual({ row: 1, col: 3, before: '0', after: '30', status: 'changed' });
    expect(at(cells, 1, 4)).toEqual({ row: 1, col: 4, before: '-', after: null, status: 'needs_check' });
  });

  it('prev가 비었거나 읽지 못하면 증감·증감률 모두 needs_check', () => {
    const t = makeTable(HEAD, [
      ['A', 5, '-', null, null],
      ['B', 5, '해당없음', null, null],
    ]);
    const { cells } = shiftColumns(
      t,
      plan,
      new Map([
        [1, 30],
        [2, 30],
      ]),
    );
    for (const row of [1, 2]) {
      expect(at(cells, row, 3)?.status).toBe('needs_check');
      expect(at(cells, row, 4)?.status).toBe('needs_check');
      expect(at(cells, row, 2)?.after).toBe('30');
    }
  });

  it('prev가 음수면 증감률 기준이 모호해 needs_check', () => {
    const t = makeTable(HEAD, [['A', 5, -100, 0, 0]]);
    const { cells } = shiftColumns(t, plan, new Map([[1, -50]]));
    expect(at(cells, 1, 3)?.after).toBe('50');
    expect(at(cells, 1, 4)?.status).toBe('needs_check');
  });

  it('감소하면 음수, 소수 값은 부동소수 찌꺼기 없이', () => {
    const t = makeTable(HEAD, [['A', 1, 1200.3, 0, 0]]);
    const { cells } = shiftColumns(t, plan, new Map([[1, 1000.1]]));
    expect(at(cells, 1, 2)?.after).toBe('1,000.1');
    expect(at(cells, 1, 3)?.after).toBe('-200.2');
    expect(at(cells, 1, 4)?.after).toBe('-16.68');
  });

  it('증감이 0이면 증감·증감률 모두 "0" ("-0" 아님)', () => {
    const t = makeTable(HEAD, [['A', 1, 10, 0, 0]]);
    const { cells } = shiftColumns(t, plan, new Map([[1, 10]]));
    expect(at(cells, 1, 3)?.after).toBe('0');
    expect(at(cells, 1, 4)?.after).toBe('0');
  });

  it('머리글 줄은 건드리지 않고 모든 자료 행을 다룬다', () => {
    const t = makeTable(HEAD, [
      ['A', 1, 2, 1, 100],
      ['B', 3, 4, 1, 33.33],
    ]);
    const { cells } = shiftColumns(
      t,
      plan,
      new Map([
        [1, 3],
        [2, 5],
      ]),
    );
    expect(cells.some((c) => c.row === 0)).toBe(false);
    expect(new Set(cells.map((c) => c.row))).toEqual(new Set([1, 2]));
  });

  it('Review Focus 3: 세로 병합에 덮인 칸은 결과에 없고 주인 칸만 있다', () => {
    // 1행(주인) + 2행(덮임): 0열 라벨, 당해(2열)·증감(3열) 세로 병합
    const t = makeTable(
      HEAD,
      [
        ['총무과', 10, 20, 10, 100],
        [null, 11, null, null, null],
        ['기획과', 30, 40, 10, 33.33],
      ],
      [
        { row: 1, col: 0, rows: 2, cols: 1 },
        { row: 1, col: 2, rows: 2, cols: 1 },
        { row: 1, col: 3, rows: 2, cols: 1 },
      ],
    );
    const { cells } = shiftColumns(
      t,
      plan,
      new Map([
        [1, 25],
        [2, 99],
        [3, 45],
      ]),
    );
    expect(at(cells, 2, 2)).toBeUndefined();
    expect(at(cells, 2, 3)).toBeUndefined();
    expect(at(cells, 1, 2)?.after).toBe('25');
    expect(at(cells, 1, 3)?.status).toBe('changed');
    // 당해가 덮인 2행: 값 주인이 윗 행이라 전년도는 비우고 확인 요청, 증감률도 확인 요청
    expect(at(cells, 2, 1)).toEqual({ row: 2, col: 1, before: '11', after: null, status: 'needs_check' });
    expect(at(cells, 2, 4)).toEqual({ row: 2, col: 4, before: '', after: null, status: 'needs_check' });
    // 병합 안의 좌표 중 주인이 아닌 것은 하나도 없다
    for (const m of t.merges) {
      for (let r = m.row; r < m.row + m.rows; r++) {
        for (let c = m.col; c < m.col + m.cols; c++) {
          if (r === m.row && c === m.col) continue;
          expect(at(cells, r, c)).toBeUndefined();
        }
      }
    }
  });
});

describe('shiftColumns — 열 종류와 칸 읽기', () => {
  const diffRate = {
    prevCol: 1,
    curCol: 2,
    diffCols: [
      { col: 3, kind: 'diff' as const },
      { col: 4, kind: 'rate' as const },
    ],
  };

  it('rate 열(증감(%))과 check 열(구성비율)', () => {
    const t = makeTable(['구분', '2024', '2025', '증감(%)', '구성비율'], [['A', 1000, 1200, 20, 40]]);
    const plan = planColumnShift(t, 2026)!;
    expect(plan.diffCols).toEqual([
      { col: 3, kind: 'rate' },
      { col: 4, kind: 'check' },
    ]);
    const { cells } = shiftColumns(t, plan, new Map([[1, 1500]]));
    expect(at(cells, 1, 3)).toEqual({ row: 1, col: 3, before: '20', after: '25', status: 'changed' });
    expect(at(cells, 1, 4)).toEqual({
      row: 1,
      col: 4,
      before: '40',
      after: null,
      status: 'needs_check',
      note: '비율 열은 다시 계산해야 합니다',
    });
  });

  it('check 열은 새 값이 있어도 모든 자료 행이 needs_check', () => {
    const t = makeTable(['구분', '2024', '2025', '구성비율'], [
      ['A', 1, 2, 10],
      ['B', 3, 4, 20],
    ]);
    const plan = planColumnShift(t, 2026)!;
    const { cells } = shiftColumns(
      t,
      plan,
      new Map([
        [1, 3],
        [2, 5],
      ]),
    );
    expect(cells.filter((c) => c.col === 3).map((c) => c.status)).toEqual(['needs_check', 'needs_check']);
  });

  it('괄호 숫자 (1,234)는 계산에 쓰지 않는다 — 복사는 글 그대로, 증감·증감률은 needs_check', () => {
    const t = makeTable(HEAD, [['A', 5, '(1,234)', 0, 0]]);
    const { cells } = shiftColumns(t, diffRate, new Map([[1, 1300]]));
    expect(at(cells, 1, 1)).toEqual({ row: 1, col: 1, before: '5', after: '(1,234)', status: 'changed' });
    expect(at(cells, 1, 2)?.after).toBe('1,300');
    expect(at(cells, 1, 3)).toMatchObject({ after: null, status: 'needs_check' });
    expect(at(cells, 1, 4)).toMatchObject({ after: null, status: 'needs_check' });
  });

  it('△100·▲ 50은 음수로 읽어 증감을 계산하고, 증감률은 기준이 음수라 확인 요청', () => {
    const t = makeTable(HEAD, [
      ['A', 5, '△100', 0, 0],
      ['B', 5, '▲ 50', 0, 0],
    ]);
    const { cells } = shiftColumns(
      t,
      diffRate,
      new Map([
        [1, 50],
        [2, 20],
      ]),
    );
    expect(at(cells, 1, 1)?.after).toBe('△100');
    expect(at(cells, 1, 3)).toMatchObject({ after: '150', status: 'changed' });
    expect(at(cells, 1, 4)).toMatchObject({ after: null, status: 'needs_check' });
    expect(at(cells, 2, 1)?.after).toBe('▲ 50');
    expect(at(cells, 2, 3)).toMatchObject({ after: '70', status: 'changed' });
    expect(at(cells, 2, 4)).toMatchObject({ after: null, status: 'needs_check' });
  });

  it('칸 끝의 단위(천원)를 새 당해·증감에 붙이고, 증감률에는 붙이지 않는다', () => {
    const t = makeTable(HEAD, [['A', '1,100천원', '1,200천원', '100천원', '9.09']]);
    const { cells } = shiftColumns(t, diffRate, new Map([[1, 1300]]));
    expect(at(cells, 1, 1)?.after).toBe('1,200천원');
    expect(at(cells, 1, 2)?.after).toBe('1,300천원');
    expect(at(cells, 1, 3)?.after).toBe('100천원');
    expect(at(cells, 1, 4)?.after).toBe('8.33');
  });

  it('칸 끝에 단위가 없으면(₩ 앞붙임) 단위를 붙이지 않는다', () => {
    const plan = { prevCol: 1, curCol: 2, diffCols: [{ col: 3, kind: 'diff' as const }] };
    const t = makeTable(['구분', '2024', '2025', '증감'], [['A', 1, '₩1,200', 0]]);
    const { cells } = shiftColumns(t, plan, new Map([[1, 1300]]));
    expect(at(cells, 1, 2)?.after).toBe('1,300');
    expect(at(cells, 1, 3)?.after).toBe('100');
  });

  it('전년도·당해·새 값이 모두 빈 행(구분선)은 결과에 없다', () => {
    const plan = { prevCol: 1, curCol: 2, diffCols: [{ col: 3, kind: 'diff' as const }] };
    const t = makeTable(['구분', '2024', '2025', '증감'], [
      ['A', 1, 2, 1],
      ['', null, '  ', null],
      ['B', 3, 4, 1],
    ]);
    const { cells } = shiftColumns(
      t,
      plan,
      new Map([
        [1, 3],
        [3, 5],
      ]),
    );
    expect(new Set(cells.map((c) => c.row))).toEqual(new Set([1, 3]));
  });

  it('새 값만 있는 행은 빈 줄이 아니다', () => {
    const t = makeTable(['구분', '2024', '2025'], [['신규', null, null]]);
    const { cells } = shiftColumns(t, { prevCol: 1, curCol: 2, diffCols: [] }, new Map([[1, 7]]));
    expect(at(cells, 1, 2)?.after).toBe('7');
  });

  it('두 줄 머리글 표: 자료는 header.to 아래부터, 병합 머리글 칸은 건드리지 않는다', () => {
    const t: ExtractedTable = {
      id: 't1',
      title: '표 1',
      cells: [
        ['구분', '예산', null, '증감'],
        [null, '2024', '2025', null],
        ['A', 10, 20, 10],
        ['B', 30, 40, 10],
      ],
      merges: [
        { row: 0, col: 1, rows: 1, cols: 2 },
        { row: 0, col: 0, rows: 2, cols: 1 },
        { row: 0, col: 3, rows: 2, cols: 1 },
      ],
      header: { from: 0, to: 1 },
      columns: ['구분', '예산 / 2024', '예산 / 2025', '증감'],
    };
    const plan = planColumnShift(t, 2026)!;
    const { cells } = shiftColumns(
      t,
      plan,
      new Map([
        [2, 25],
        [3, 45],
      ]),
    );
    expect(new Set(cells.map((c) => c.row))).toEqual(new Set([2, 3]));
    expect(at(cells, 2, 1)).toEqual({ row: 2, col: 1, before: '10', after: '20', status: 'changed' });
    expect(at(cells, 2, 2)).toEqual({ row: 2, col: 2, before: '20', after: '25', status: 'changed' });
    expect(at(cells, 2, 3)).toEqual({ row: 2, col: 3, before: '10', after: '5', status: 'changed' });
    expect(at(cells, 3, 3)?.after).toBe('5');
  });
});
