import { describe, it, expect } from 'vitest';
import { buildTable } from '@/lib/attachments/header';
import type { Cell, TableMerge } from '@/lib/attachments/types';
import { combineTables } from '@/lib/table-engine/combine';
import type { CombineResult, SourceSpec, SourceTable } from '@/lib/table-engine/types';

/** 작은 원천 표. file·table은 지시가 가리키는 ref */
function src(
  file: string,
  cells: Cell[][],
  opts: { caption?: string; merges?: TableMerge[]; spec?: Partial<SourceSpec>; fileName?: string; table?: string } = {}
): SourceTable {
  const table = buildTable(1, '시트1', cells, opts.merges ?? [], opts.caption);
  if (opts.table) table.id = opts.table;
  return {
    spec: { file, table: table.id, ...opts.spec },
    fileName: opts.fileName ?? `${file}.xlsx`,
    table,
  };
}

function combine(sources: SourceTable[], extra: Record<string, unknown> = {}): CombineResult {
  return combineTables(sources, { sources: sources.map((s) => s.spec), ...extra });
}

function ok(r: CombineResult) {
  if (!r.ok) throw new Error(`실패: ${r.error}`);
  return r;
}

describe('combineTables — 원천 준비와 쌓기', () => {
  it('두 파일을 열 이름으로 쌓고 출처 열을 붙인다', () => {
    const r = ok(
      combine(
        [
          src('a1', [['부서', '예산'], ['총무과', 100], ['기획과', 50]], { fileName: '예산.xlsx' }),
          src('a2', [['부서', '예산'], ['총무과', 200], ['인사과', 30]], { fileName: '현황.xlsx' }),
        ],
        { add_source_column: true }
      )
    );
    expect(r.columns.map((c) => c.name)).toEqual(['출처', '부서', '예산']);
    expect(r.columns.map((c) => c.numeric)).toEqual([false, false, true]);
    expect(r.rows).toEqual([
      ['예산.xlsx', '총무과', 100],
      ['예산.xlsx', '기획과', 50],
      ['현황.xlsx', '총무과', 200],
      ['현황.xlsx', '인사과', 30],
    ]);
    expect(r.total).toBeNull();
    expect(r.lineage.onlyIn).toEqual([]);
    expect(r.lineage.rowCounts).toEqual({ stacked: 4, filtered: 4, result: 4 });
    expect(r.lineage.truncated).toBe(false);
    expect(r.lineage.sources).toEqual([
      { file: 'a1', fileName: '예산.xlsx', table: 't1', title: '시트1', headerRows: [1, 1], rowsIn: 2, rowsUsed: 2 },
      { file: 'a2', fileName: '현황.xlsx', table: 't1', title: '시트1', headerRows: [1, 1], rowsIn: 2, rowsUsed: 2 },
    ]);
  });

  it('출처 열 없이 쌓고, 한쪽에만 있는 열은 null로 채우고 onlyIn에 남긴다', () => {
    const r = ok(
      combine([
        src('a1', [['부서', '예산', '비고'], ['총무과', 100, '정상']]),
        src('a2', [['부서', '예산'], ['기획과', 50]]),
      ])
    );
    expect(r.columns.map((c) => c.name)).toEqual(['부서', '예산', '비고']);
    expect(r.rows).toEqual([
      ['총무과', 100, '정상'],
      ['기획과', 50, null],
    ]);
    expect(r.lineage.onlyIn).toEqual([{ column: '비고', files: ['a1/t1'] }]);
  });

  it('원천의 합계·소 계 행은 기본으로 빠지고 근거에 남는다', () => {
    const r = ok(
      combine([
        src('a1', [['부서', '예산'], ['총무과', 100], ['기획과', 50], ['소 계', 150], [null, null], ['합계', 150]]),
      ])
    );
    expect(r.rows).toEqual([
      ['총무과', 100],
      ['기획과', 50],
    ]);
    expect(r.rows.flat()).not.toContain('합계');
    expect(r.lineage.skippedRows).toEqual([
      { file: 'a1', table: 't1', row: 4, reason: '합계 행', text: '소 계 | 150' },
      { file: 'a1', table: 't1', row: 6, reason: '합계 행', text: '합계 | 150' },
    ]);
    // 빈 행은 근거에 남기지 않는다 — rowsIn에도 들지 않는다
    expect(r.lineage.sources[0]).toMatchObject({ rowsIn: 4, rowsUsed: 2 });
  });

  it('병합된 구분 칸 아래의 소계 행도 빠진다 — 아래로 채우기 전의 칸으로 판정', () => {
    const r = ok(
      combine([
        src(
          'a1',
          [
            ['구분', '항목', '예산'],
            ['총무과', '인건비', 100],
            [null, '운영비', 50],
            [null, '소계', 150],
            ['총 계', null, 150],
          ],
          { merges: [{ row: 1, col: 0, rows: 3, cols: 1 }] }
        ),
      ])
    );
    expect(r.rows).toEqual([
      ['총무과', '인건비', 100],
      ['총무과', '운영비', 50],
    ]);
    expect(r.lineage.skippedRows.map((s) => [s.row, s.reason])).toEqual([
      [4, '합계 행'],
      [5, '합계 행'],
    ]);
  });

  it('skip_rows_matching으로 더 뺀다', () => {
    const r = ok(
      combine([
        src('a1', [['부서', '예산'], ['총무과', 100], ['누 계', 900], ['기획과', 50]], {
          spec: { skip_rows_matching: ['누계'] },
        }),
      ])
    );
    expect(r.rows).toEqual([
      ['총무과', 100],
      ['기획과', 50],
    ]);
    expect(r.lineage.skippedRows).toEqual([{ file: 'a1', table: 't1', row: 3, reason: '지정한 글', text: '누 계 | 900' }]);
  });

  it('단위가 다르면 거부하고 원천별 단위를 알려 준다', () => {
    const r = combine([
      src('a1', [['부서', '예산'], ['총무과', 100]], { caption: '(단위: 천원)' }),
      src('a2', [['부서', '예산'], ['기획과', 50000]], { caption: '(단위: 원)' }),
    ]);
    expect(r).toEqual({
      ok: false,
      error:
        '열 "예산"의 단위가 원천마다 다릅니다: a1/t1=천원, a2/t1=원. scale로 맞춘 뒤 다시 계산하세요(예: a2의 "예산"에 0.001).',
    });
  });

  it('캡션의 천원과 열 이름의 (원)도 같은 열로 보고 거부한다', () => {
    const r = combine([
      src('a1', [['부서', '예산'], ['총무과', 100]], { caption: '(단위: 천원)' }),
      src('a2', [['부서', '예산(원)'], ['기획과', 50000]]),
    ]);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toContain('a1/t1=천원');
    expect(r.error).toContain('a2/t1=원');
    expect(r.error).toContain('scale');
  });

  it('바꿀 수 없는 단위끼리면 scale 예시 없이 거부한다', () => {
    const r = combine([
      src('a1', [['부서', '수량'], ['총무과', 100]], { caption: '(단위: 명)' }),
      src('a2', [['부서', '수량'], ['기획과', 5]], { caption: '(단위: 건)' }),
    ]);
    expect(r).toEqual({
      ok: false,
      error: '열 "수량"의 단위가 원천마다 다릅니다: a1/t1=명, a2/t1=건. 서로 바꿀 수 없는 단위라 같은 열인지 확인하세요.',
    });
  });

  it('scale로 맞추면 통과하고 근거에 남는다', () => {
    const r = ok(
      combine([
        src('a1', [['부서', '예산'], ['총무과', 100]], { caption: '(단위: 천원)' }),
        src('a2', [['부서', '예산(원)'], ['기획과', 50000], ['인사과', 1234]], { spec: { scale: { 예산: 0.001 } } }),
      ])
    );
    expect(r.columns).toEqual([
      { name: '부서', unit: null, numeric: false },
      { name: '예산(천원)', unit: '천원', numeric: true },
    ]);
    expect(r.rows).toEqual([
      ['총무과', 100],
      ['기획과', 50],
      ['인사과', 1.234],
    ]);
    expect(r.lineage.scaled).toEqual([{ file: 'a2', column: '예산(원)', factor: 0.001 }]);
    expect(r.lineage.unitWarnings).toEqual([]);
  });

  it('일부만 단위를 모르면 경고', () => {
    const r = ok(
      combine([
        src('a1', [['부서', '예산'], ['총무과', 100]], { caption: '(단위: 천원)' }),
        src('a2', [['부서', '예산'], ['기획과', 50]]),
      ])
    );
    expect(r.columns[1]).toEqual({ name: '예산(천원)', unit: '천원', numeric: true });
    expect(r.lineage.unitWarnings).toEqual(['열 "예산": a2/t1은 단위를 알 수 없습니다 — 같은 단위인지 확인하세요']);
  });

  it('이미 괄호 단위가 있는 열 이름은 그대로 둔다', () => {
    const r = ok(combine([src('a1', [['부서', '예산(천원)'], ['총무과', 100]])]));
    expect(r.columns[1]).toEqual({ name: '예산(천원)', unit: '천원', numeric: true });
  });

  it('% 단위는 결과 열에 그대로 남긴다', () => {
    const r = ok(combine([src('a1', [['부서', '집행률'], ['총무과', '12.5%'], ['기획과', '30%']])]));
    expect(r.columns[1]).toEqual({ name: '집행률(%)', unit: '%', numeric: true });
    expect(r.rows.map((row) => row[1])).toEqual([12.5, 30]);
  });

  it('읽지 못한 칸은 null로 두고 위치를 남긴다(0 아님)', () => {
    const r = ok(combine([src('a1', [['부서', '예산'], ['총무과', 100], ['기획과', '미제출'], ['인사과', 50]])]));
    expect(r.columns[1].numeric).toBe(true);
    expect(r.rows.map((row) => row[1])).toEqual([100, null, 50]);
    expect(r.lineage.unreadable).toEqual([{ file: 'a1', table: 't1', row: 3, column: '예산', text: '미제출' }]);
  });

  it('열 단위와 다른 단위가 적힌 칸은 더하지 않고 읽지 못함으로 남긴다', () => {
    const r = ok(combine([src('a1', [['부서', '예산(원)'], ['총무과', 1000], ['기획과', '3,000천원']])]));
    expect(r.rows.map((row) => row[1])).toEqual([1000, null]);
    expect(r.lineage.unreadable).toEqual([
      { file: 'a1', table: 't1', row: 3, column: '예산(원)', text: '3,000천원', reason: '열 단위(원)와 다른 단위(천원)' },
    ]);
  });

  it('열 단위를 정하지 못했는데 칸마다 단위가 다르면 단위가 적힌 칸을 읽지 못함으로 둔다', () => {
    const r = ok(combine([src('a1', [['부서', '예산'], ['총무과', '100원'], ['기획과', '3천원'], ['인사과', 5], ['재무과', 6]])]));
    expect(r.rows.map((row) => row[1])).toEqual([null, null, 5, 6]);
    expect(r.lineage.unreadable.map((u) => [u.row, u.text, u.reason])).toEqual([
      [2, '100원', '칸마다 단위가 달라 어느 단위인지 알 수 없음'],
      [3, '3천원', '칸마다 단위가 달라 어느 단위인지 알 수 없음'],
    ]);
  });

  it('괄호 숫자를 음수로 읽었으면 열마다 한 번 경고한다', () => {
    const r = ok(combine([src('a1', [['부서', '예산'], ['총무과', '(100)'], ['기획과', '(20)'], ['인사과', 50]])]));
    expect(r.rows.map((row) => row[1])).toEqual([-100, -20, 50]);
    expect(r.lineage.parenthesizedNegatives).toEqual([
      '열 "예산": a1/t1의 괄호 숫자 2개를 음수로 읽었습니다 — 괄호가 부분 금액이면 확인하세요',
    ]);
  });

  it('세로 병합된 부서 칸은 아래로 채우고, 병합된 숫자는 한 번만', () => {
    const r = ok(
      combine([
        src(
          'a1',
          [
            ['부서', '팀', '예산'],
            ['총무과', 'A팀', 100],
            [null, 'B팀', null],
            ['기획과', 'C팀', 30],
          ],
          {
            merges: [
              { row: 1, col: 0, rows: 2, cols: 1 },
              { row: 1, col: 2, rows: 2, cols: 1 },
            ],
          }
        ),
      ])
    );
    expect(r.rows).toEqual([
      ['총무과', 'A팀', 100],
      ['총무과', 'B팀', null],
      ['기획과', 'C팀', 30],
    ]);
    expect(r.lineage.mergedNumbers).toEqual([{ file: 'a1', table: 't1', row: 2, column: '예산' }]);
  });

  it('rename으로 열 이름을 맞춘다', () => {
    const r = ok(
      combine([
        src('a1', [['부서', '예산액'], ['총무과', 100]], { spec: { rename: { 예산액: '예산' } } }),
        src('a2', [['부서', '예산'], ['기획과', 50]]),
      ])
    );
    expect(r.columns.map((c) => c.name)).toEqual(['부서', '예산']);
    expect(r.rows).toEqual([
      ['총무과', 100],
      ['기획과', 50],
    ]);
    expect(r.lineage.renamed).toEqual([{ file: 'a1', from: '예산액', to: '예산' }]);
    expect(r.lineage.onlyIn).toEqual([]);
  });

  it('rename으로 같은 이름이 둘이 되면 실패', () => {
    const r = combine([src('a1', [['부서', '예산', '예산액'], ['총무과', 100, 1]], { spec: { rename: { 예산액: '예산' } } })]);
    expect(r).toEqual({ ok: false, error: 'a1/t1에서 이름을 바꾸면 "예산" 열이 둘이 됩니다.' });
  });

  it('없는 열이면 실제 열 이름을 돌려준다', () => {
    const cells: Cell[][] = [['부서', '예산(천원)', '비고'], ['총무과', 100, '정상']];
    expect(combine([src('a1', cells, { spec: { rename: { 예산액: '예산' } } })])).toEqual({
      ok: false,
      error: 'a1/t1에 "예산액" 열이 없습니다. 있는 열: 부서, 예산(천원), 비고',
    });
    expect(combine([src('a1', cells, { spec: { scale: { 예산액: 0.001 } } })])).toEqual({
      ok: false,
      error: 'a1/t1에 "예산액" 열이 없습니다. 있는 열: 부서, 예산(천원), 비고',
    });
  });

  it('숫자 열이 아닌 열에 scale을 주면 실패', () => {
    const r = combine([src('a1', [['부서', '예산'], ['총무과', 100]], { spec: { scale: { 부서: 10 } } })]);
    expect(r).toEqual({ ok: false, error: 'a1/t1의 "부서"는 숫자 열이 아니라 scale을 쓸 수 없습니다.' });
  });

  it('scale 값이 0이거나 숫자가 아니면 실패', () => {
    const r = combine([src('a1', [['부서', '예산'], ['총무과', 100]], { spec: { scale: { 예산: 0 } } })]);
    expect(r).toEqual({ ok: false, error: 'a1/t1의 "예산" scale은 0보다 큰 숫자여야 합니다.' });
  });

  it('header_rows로 머리글을 다시 잡는다', () => {
    const r = ok(
      combine([
        src('a1', [['부서', '예산'], ['구분', '금액'], ['총무과', 100]], { spec: { header_rows: [2, 2] } }),
      ])
    );
    expect(r.columns.map((c) => c.name)).toEqual(['구분', '금액']);
    expect(r.rows).toEqual([['총무과', 100]]);
    expect(r.lineage.sources[0].headerRows).toEqual([2, 2]);
  });

  it('header_rows가 표 밖이면 실패', () => {
    const r = combine([src('a1', [['부서', '예산'], ['총무과', 100]], { spec: { header_rows: [2, 5] } })]);
    expect(r).toEqual({
      ok: false,
      error: 'a1/t1의 머리글 행(header_rows) 지정이 맞지 않습니다. 1부터 2 사이의 [시작, 끝]으로 주세요.',
    });
  });

  it('지시가 가리킨 표를 받지 못했으면 실패하고 받은 표를 알려 준다', () => {
    const a1 = src('a1', [['부서', '예산'], ['총무과', 100]]);
    const r = combineTables([a1], { sources: [a1.spec, { file: 'a2', table: 't3' }] });
    expect(r).toEqual({ ok: false, error: 'a2/t3 표를 찾지 못했습니다. 받은 표: a1/t1' });
    expect(combineTables([], { sources: [] })).toEqual({ ok: false, error: '합칠 표가 없습니다.' });
  });

  it('원천에 이미 "출처" 열이 있는데 출처 열을 붙이라면 실패', () => {
    const r = combine([src('a1', [['출처', '예산'], ['본청', 100]])], { add_source_column: true });
    expect(r).toEqual({ ok: false, error: '"출처" 열이 이미 있습니다. rename으로 이름을 바꾼 뒤 다시 계산하세요.' });
  });

  it('머리글이 없고 값도 없는 빈 열은 버린다', () => {
    const r = ok(combine([src('a1', [['부서', null, '예산'], ['총무과', null, 100]])]));
    expect(r.columns.map((c) => c.name)).toEqual(['부서', '예산']);
    expect(r.rows).toEqual([['총무과', 100]]);
  });
});
