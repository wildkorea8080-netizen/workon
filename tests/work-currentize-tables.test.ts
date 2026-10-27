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
    const t = makeTable(['구분', "'24", '2025년(안)', '비율'], []);
    expect(planColumnShift(t, 2026)).toEqual({ prevCol: 1, curCol: 2, diffCols: [{ col: 3, kind: 'rate' }] });
    const t2 = makeTable(['구분', '2024년도', '’25', '전년 대비 차이'], []);
    expect(planColumnShift(t2, 2026)).toEqual({ prevCol: 1, curCol: 2, diffCols: [{ col: 3, kind: 'diff' }] });
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
    // 덮이지 않은 칸(2행 전년도·증감률)은 그대로 있다
    expect(at(cells, 2, 1)).toBeDefined();
    expect(at(cells, 2, 4)).toBeDefined();
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
