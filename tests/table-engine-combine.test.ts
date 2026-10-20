import { describe, it, expect } from 'vitest';
import { buildTable } from '@/lib/attachments/header';
import type { Cell, TableMerge } from '@/lib/attachments/types';
import { combineTables, stackTables } from '@/lib/table-engine/combine';
import type { CombineResult, SourceSpec, SourceTable } from '@/lib/table-engine/types';

type Src = SourceTable & { spec: SourceSpec };

/** 작은 원천 표와 그 원천을 가리키는 지시 한 줄 */
function src(
  file: string,
  cells: Cell[][],
  opts: { caption?: string; merges?: TableMerge[]; spec?: Partial<SourceSpec>; fileName?: string } = {}
): Src {
  const table = buildTable(1, '시트1', cells, opts.merges ?? [], opts.caption);
  return { file, fileName: opts.fileName ?? `${file}.xlsx`, table, spec: { file, table: table.id, ...opts.spec } };
}

function combine(sources: Src[], extra: Record<string, unknown> = {}): CombineResult {
  return combineTables(sources, { sources: sources.map((s) => s.spec), ...extra });
}

function ok(r: CombineResult) {
  if (!r.ok) throw new Error(`실패: ${r.error}`);
  return r;
}

const CAP_THOUSAND = '(단위: 천원)';

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

  it('원천 옵션은 지시(spec.sources)에서 온다 — 순서도 지시 순서', () => {
    const a1 = src('a1', [['부서', '예산'], ['총무과', 100]]);
    const a2 = src('a2', [['부서', '예산'], ['기획과', 50]]);
    const r = ok(
      combineTables([a1, a2], {
        sources: [
          { file: 'a2', table: 't1' },
          { file: 'a1', table: 't1', rename: { 예산: '금액' } },
        ],
      })
    );
    expect(r.columns.map((c) => c.name)).toEqual(['부서', '예산', '금액']);
    expect(r.rows).toEqual([
      ['기획과', 50, null],
      ['총무과', null, 100],
    ]);
  });
});

describe('합계 행 빼기', () => {
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
    expect(r.lineage.skippedRows).toEqual([
      { file: 'a1', table: 't1', row: 4, reason: '합계 행', text: '소 계 | 150' },
      { file: 'a1', table: 't1', row: 6, reason: '합계 행', text: '합계 | 150' },
    ]);
    // 빈 행은 근거에 남기지 않는다 — rowsIn에도 들지 않는다
    expect(r.lineage.sources[0]).toMatchObject({ rowsIn: 4, rowsUsed: 2 });
  });

  it('병합된 구분 칸 아래의 소계 행도 빠진다', () => {
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

  it('합계 표기의 변형도 뺀다 — 끝 괄호·[ ]·앞 ※·영문, 누계는 남긴다', () => {
    const labels = [
      '합 계', '총계', '계', '합계(A)', '합계 (A+B)', '소계(1)', '총 합계', '총합계', '[합계]', '※ 합계', '* 소계',
      '합   계', 'Total', 'TOTAL', 'Subtotal',
    ];
    const cells: Cell[][] = [['부서', '예산'], ['총무과', 100], ...labels.map((l) => [l, 100] as Cell[]), ['누계', 900]];
    const r = ok(combine([src('a1', cells)]));
    expect(r.rows).toEqual([
      ['총무과', 100],
      ['누계', 900],
    ]);
    expect(r.lineage.skippedRows).toHaveLength(labels.length);
  });

  it('순번 뒤의 소계, 구분 뒤의 소계(병합 아님)도 뺀다 — 앞 두 글자 열을 본다', () => {
    const r1 = ok(
      combine([src('a1', [['연번', '부서', '예산'], [1, '총무과', 100], [2, '기획과', 50], [3, '소계', 150], [null, '합계', 150]])])
    );
    expect(r1.rows).toEqual([
      [1, '총무과', 100],
      [2, '기획과', 50],
    ]);
    const r2 = ok(
      combine([src('a1', [['구분', '부서', '예산'], ['본청', '총무과', 100], ['본청', '기획과', 50], ['본청', '소계', 150]])])
    );
    expect(r2.rows).toEqual([
      ['본청', '총무과', 100],
      ['본청', '기획과', 50],
    ]);
  });

  it('여러 칸에 걸쳐 병합된 합계 행도 뺀다', () => {
    const r = ok(
      combine([
        src('a1', [['구분', '부서', '예산'], ['본청', '총무과', 100], ['합계', null, 100]], {
          merges: [{ row: 2, col: 0, rows: 1, cols: 2 }],
        }),
      ])
    );
    expect(r.rows).toEqual([['본청', '총무과', 100]]);
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
});

describe('단위', () => {
  it('단위가 다르면 거부하고 원천별 단위를 알려 준다 — 표 위 글에서 온 단위는 표시', () => {
    const r = combine([
      src('a1', [['부서', '예산'], ['총무과', 100]], { caption: CAP_THOUSAND }),
      src('a2', [['부서', '예산'], ['기획과', 50000]], { caption: '(단위: 원)' }),
    ]);
    expect(r).toEqual({
      ok: false,
      error:
        '열 "예산"의 단위가 원천마다 다릅니다: a1/t1=천원(표 위 글), a2/t1=원(표 위 글). scale로 맞춘 뒤 다시 계산하세요(예: a2의 "예산"에 0.001).',
    });
  });

  it('캡션의 천원과 열 이름의 (원)도 같은 열로 보고 거부한다', () => {
    const r = combine([
      src('a1', [['부서', '예산'], ['총무과', 100]], { caption: CAP_THOUSAND }),
      src('a2', [['부서', '예산(원)'], ['기획과', 50000]]),
    ]);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toContain('a1/t1=천원(표 위 글)');
    expect(r.error).toContain('a2/t1=원.');
    expect(r.error).toContain('scale');
  });

  it('캡션의 천원은 인원 열에 붙지 않는다', () => {
    const r = ok(combine([src('a1', [['부서', '인원', '예산'], ['총무과', 12, 100], ['기획과', 8, 50]], { caption: CAP_THOUSAND })]));
    expect(r.columns).toEqual([
      { name: '부서', unit: null, numeric: false },
      { name: '인원', unit: null, numeric: true },
      { name: '예산(천원)', unit: '천원', numeric: true },
    ]);
  });

  it('캡션 천원 vs 캡션 원: 예산만 거부하고 인원은 문제 삼지 않는다', () => {
    const A: Cell[][] = [['부서', '인원', '예산'], ['총무과', 12, 100], ['기획과', 8, 50]];
    const B: Cell[][] = [['부서', '인원', '예산'], ['인사과', 5, 30000]];
    const r = combine([src('a1', A, { caption: CAP_THOUSAND }), src('a2', B, { caption: '(단위: 원)' })]);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toContain('열 "예산"');
    expect(r.error).not.toContain('인원');
    // 안내대로 예산만 맞추면 통과한다
    const fixed = ok(
      combine([src('a1', A, { caption: CAP_THOUSAND }), src('a2', B, { caption: '(단위: 원)', spec: { scale: { 예산: 0.001 } } })])
    );
    expect(fixed.columns.map((c) => c.name)).toEqual(['부서', '인원', '예산(천원)']);
    expect(fixed.rows.map((row) => row[2])).toEqual([100, 50, 30]);
  });

  it('인원과 인원(명)은 한 열로 쌓인다', () => {
    const r = ok(
      combine([
        src('a1', [['부서', '인원', '예산'], ['총무과', 12, 100]], { caption: CAP_THOUSAND }),
        src('a2', [['부서', '인원(명)', '예산'], ['인사과', 5, 30]], { caption: CAP_THOUSAND }),
      ])
    );
    expect(r.columns.map((c) => c.name)).toEqual(['부서', '인원(명)', '예산(천원)']);
    expect(r.rows).toEqual([
      ['총무과', 12, 100],
      ['인사과', 5, 30],
    ]);
    expect(r.lineage.unitWarnings).toEqual(['열 "인원": a1/t1은 단위를 알 수 없습니다 — 같은 단위인지 확인하세요']);
  });

  it('차원이 다른 단위 괄호는 떼어 맞추지 않는다 — 인원(명)과 인원(%)은 다른 열', () => {
    const r = ok(combine([src('a1', [['부서', '인원(명)'], ['a', 3]]), src('a2', [['부서', '인원(%)'], ['b', 40]])]));
    expect(r.columns.map((c) => c.name)).toEqual(['부서', '인원(명)', '인원(%)']);
    const r2 = ok(combine([src('a1', [['부서', '증감(%)'], ['a', 3]]), src('a2', [['부서', '증감(%p)'], ['b', 4]])]));
    expect(r2.columns.map((c) => c.name)).toEqual(['부서', '증감(%)', '증감(%p)']);
  });

  it('바꿀 수 없는 단위끼리면 scale 예시 없이 거부한다', () => {
    const r = combine([
      src('a1', [['부서', '실적'], ['총무과', 100]], { caption: '(단위: 명)' }),
      src('a2', [['부서', '실적'], ['기획과', 5]], { caption: '(단위: 건)' }),
    ]);
    expect(r).toEqual({
      ok: false,
      error: '열 "실적"의 단위가 원천마다 다릅니다: a1/t1=명(표 위 글), a2/t1=건(표 위 글). 서로 바꿀 수 없는 단위라 같은 열인지 확인하세요.',
    });
  });

  it('돈이 아닌 단위는 크기만 달라도 scale 숫자 예시를 주지 않는다', () => {
    const r = combine([src('a1', [['부서', '인원(명)'], ['a', 3]]), src('a2', [['부서', '인원(천명)'], ['b', 4]])]);
    expect(r).toEqual({
      ok: false,
      error: '열 "인원"의 단위가 원천마다 다릅니다: a1/t1=명, a2/t1=천명. scale로 맞춘 뒤 다시 계산하세요.',
    });
  });

  it('scale로 맞추면 통과하고 근거에 남는다', () => {
    const r = ok(
      combine([
        src('a1', [['부서', '예산'], ['총무과', 100]], { caption: CAP_THOUSAND }),
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

  it('scale 방향이 거꾸로면 거부한다', () => {
    const r = combine([
      src('a1', [['부서', '예산'], ['a', 100]], { caption: CAP_THOUSAND }),
      src('a2', [['부서', '예산'], ['b', 30000]], { caption: '(단위: 원)', spec: { scale: { 예산: 1000 } } }),
    ]);
    expect(r).toEqual({ ok: false, error: 'scale 방향/크기가 단위와 맞지 않습니다 (a2 원×1000 ≠ 천원)' });
  });

  it('scale한 원천은 환산된 단위를 아는 단위로 친다', () => {
    const r = ok(
      combine([
        src('a1', [['부서', '예산'], ['a', 100]], { caption: CAP_THOUSAND, spec: { scale: { 예산: 1000 } } }),
        src('a2', [['부서', '예산'], ['b', 30000]]),
      ])
    );
    expect(r.columns[1]).toEqual({ name: '예산(원)', unit: '원', numeric: true });
    expect(r.rows.map((row) => row[1])).toEqual([100000, 30000]);
    expect(r.lineage.unitWarnings).toEqual(['열 "예산": a2/t1은 단위를 알 수 없습니다 — 같은 단위인지 확인하세요']);
  });

  it('단위를 모르는 열에 준 scale은 맞는지 확인할 수 없다고 경고한다', () => {
    const A: Cell[][] = [['부서', '인원', '예산'], ['총무과', 12, 100]];
    const B: Cell[][] = [['부서', '인원', '예산'], ['인사과', 5, 30000]];
    const r = ok(
      combine([
        src('a1', A, { caption: CAP_THOUSAND }),
        src('a2', B, { caption: '(단위: 원)', spec: { scale: { 예산: 0.001, 인원: 0.001 } } }),
      ])
    );
    expect(r.lineage.unitWarnings).toEqual([
      '열 "인원": a2/t1은 단위를 알 수 없어 scale ×0.001이 맞는지 확인하지 못했습니다',
    ]);
  });

  it('일부만 단위를 모르면 경고', () => {
    const r = ok(
      combine([
        src('a1', [['부서', '예산'], ['총무과', 100]], { caption: CAP_THOUSAND }),
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
});

describe('값 읽기', () => {
  it('읽지 못한 칸은 null로 두고 위치를 남긴다(0 아님)', () => {
    const r = ok(combine([src('a1', [['부서', '예산'], ['총무과', 100], ['기획과', '미제출'], ['인사과', 50]])]));
    expect(r.columns[1].numeric).toBe(true);
    expect(r.rows.map((row) => row[1])).toEqual([100, null, 50]);
    expect(r.lineage.unreadable).toEqual([{ file: 'a1', table: 't1', row: 3, column: '예산', text: '미제출' }]);
  });

  it('숫자가 있지만 과반이 안 돼 글자 열로 두면 경고', () => {
    const r = ok(combine([src('a1', [['부서', '예산'], ['총무과', 100], ['기획과', '미제출'], ['인사과', '검토중']])]));
    expect(r.columns[1].numeric).toBe(false);
    expect(r.rows.map((row) => row[1])).toEqual([100, '미제출', '검토중']);
    expect(r.lineage.columnWarnings).toEqual([
      '열 "예산": 숫자로 읽힌 값이 절반이 안 돼 글자 열로 두었습니다(숫자 1, 읽지 못함 2)',
    ]);
    // 숫자가 하나도 없는 글자 열은 경고하지 않는다
    expect(ok(combine([src('a1', [['부서', '비고'], ['총무과', '정상']])])).lineage.columnWarnings).toEqual([]);
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
    expect(r.lineage.mergedNumbers).toEqual([{ file: 'a1', table: 't1', row: 2, rowEnd: 3, column: '예산' }]);
  });

  it('병합된 숫자 라벨(연도)은 키용 행에서 아래로 채우고, 집계용 행에서는 한 번만', () => {
    const cells: Cell[][] = [
      ['연도', '분기', '예산'],
      [2025, '1분기', 10],
      [null, '2분기', 20],
      [2026, '1분기', 30],
      [null, '2분기', 40],
    ];
    const merges = [
      { row: 1, col: 0, rows: 2, cols: 1 },
      { row: 3, col: 0, rows: 2, cols: 1 },
    ];
    const a1 = src('a1', cells, { merges });
    const s = stackTables([a1], { sources: [a1.spec] });
    if (!s.ok) throw new Error(s.error);
    expect(s.rows.map((r) => r.keys)).toEqual([
      [2025, '1분기', 10],
      [2025, '2분기', 20],
      [2026, '1분기', 30],
      [2026, '2분기', 40],
    ]);
    expect(s.rows.map((r) => r.values)).toEqual([
      [2025, '1분기', 10],
      [null, '2분기', 20],
      [2026, '1분기', 30],
      [null, '2분기', 40],
    ]);
    expect(s.rows.map((r) => [r.source, r.row])).toEqual([
      [0, 2],
      [0, 3],
      [0, 4],
      [0, 5],
    ]);
    // 쌓은 결과 rows는 집계용 행
    expect(ok(combine([a1])).rows.map((r) => r[0])).toEqual([2025, null, 2026, null]);
  });
});

describe('열 이름', () => {
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
      combine([src('a1', [['부서', '예산'], ['구분', '금액'], ['총무과', 100]], { spec: { header_rows: [2, 2] } })])
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

describe('원천 지정', () => {
  it('지시가 가리킨 표를 받지 못했으면 실패하고 받은 표를 알려 준다', () => {
    const a1 = src('a1', [['부서', '예산'], ['총무과', 100]]);
    const r = combineTables([a1], { sources: [a1.spec, { file: 'a2', table: 't3' }] });
    expect(r).toEqual({ ok: false, error: 'a2/t3 표를 찾지 못했습니다. 받은 표: a1/t1' });
    expect(combineTables([], { sources: [] })).toEqual({ ok: false, error: '합칠 표가 없습니다.' });
  });

  it('같은 표를 두 번 지정하면 실패 — 두 번 더해진다', () => {
    const a1 = src('a1', [['부서', '예산'], ['총무과', 100]]);
    expect(combineTables([a1], { sources: [a1.spec, a1.spec] })).toEqual({
      ok: false,
      error: 'a1/t1을 두 번 지정했습니다',
    });
  });
});


describe('수정 2차 — 병합된 합계 라벨·라벨 열', () => {
  it('여러 행에 병합된 합계 라벨은 병합이 덮는 모든 행을 뺀다', () => {
    const r = ok(
      combine([
        src(
          'a1',
          [
            ['구분', '항목', '금액'],
            ['총무과', '예산', 100],
            ['총무과', '결산', 90],
            ['기획과', '예산', 200],
            ['기획과', '결산', 180],
            ['합계', '예산', 300],
            [null, '결산', 270],
          ],
          { merges: [{ row: 5, col: 0, rows: 2, cols: 1 }] }
        ),
      ])
    );
    expect(r.rows.map((row) => row[2])).toEqual([100, 90, 200, 180]);
    expect(r.lineage.skippedRows.map((s) => [s.row, s.reason])).toEqual([
      [6, '합계 행'],
      [7, '합계 행'],
    ]);
  });

  it('국비·시비 두 행에 병합된 소계도 두 행 다 뺀다', () => {
    const r = ok(
      combine([
        src(
          'a1',
          [
            ['부서', '구분', '재원', '금액'],
            ['총무과', '사업A', '국비', 10],
            ['총무과', '사업A', '시비', 5],
            ['총무과', '소계', '국비', 10],
            ['총무과', null, '시비', 5],
          ],
          { merges: [{ row: 3, col: 1, rows: 2, cols: 1 }] }
        ),
      ])
    );
    expect(r.rows.map((row) => row[3])).toEqual([10, 5]);
    expect(r.lineage.skippedRows).toHaveLength(2);
  });

  it('2행×2열로 병합된 합계도 뺀다', () => {
    const r = ok(
      combine([
        src(
          'a1',
          [
            ['구분', '세부', '금액'],
            ['총무과', 'A', 10],
            ['총무과', 'B', 20],
            ['합계', null, 30],
            [null, null, 30],
          ],
          { merges: [{ row: 3, col: 0, rows: 2, cols: 2 }] }
        ),
      ])
    );
    expect(r.rows.map((row) => row[2])).toEqual([10, 20]);
    expect(r.lineage.skippedRows.map((s) => s.row)).toEqual([4, 5]);
  });

  it('숫자 열 오른쪽의 비고에 적힌 계·소계·합계는 데이터다', () => {
    const r = ok(
      combine([
        src('a1', [
          ['부서', '예산', '비고'],
          ['총무과', 10, '계(추정)'],
          ['기획과', 20, '소계(포함)'],
          ['인사과', 5, '[합계]'],
          ['감사과', 7, '총계'],
          ['재무과', 3, '계속사업'],
        ]),
      ])
    );
    expect(r.rows.map((row) => row[0])).toEqual(['총무과', '기획과', '인사과', '감사과', '재무과']);
    expect(r.lineage.skippedRows).toEqual([]);
  });

  it('연번 뒤 첫 숫자 열 왼쪽의 글자 열은 모두 본다 — 셋째 열의 합계', () => {
    const r = ok(combine([src('a1', [['연번', '부서', '팀', '예산'], [1, '총무과', 'A', 10], [null, '총무과', '합계', 10]])]));
    expect(r.rows).toEqual([[1, '총무과', 'A', 10]]);
  });

  it('구분 아래 항목이 계인 행은 합계 행이다', () => {
    const r = ok(
      combine([src('a1', [['구분', '항목', '금액'], ['일반회계', '계', 30], ['일반회계', '인건비', 10], ['일반회계', '운영비', 20]])])
    );
    expect(r.rows.map((row) => row[1])).toEqual(['인건비', '운영비']);
  });
});

describe('수정 2차 — scale·단위', () => {
  it('scale 예시는 열 이름 차원이 돈일 때만 — 학생수는 캡션 돈 단위를 받지 않는다', () => {
    const A: Cell[][] = [['학교', '학생수', '예산'], ['A', 300, 100]];
    const B: Cell[][] = [['학교', '학생수', '예산'], ['B', 200, 50000]];
    const r = combine([src('a1', A, { caption: CAP_THOUSAND }), src('a2', B, { caption: '(단위: 원)' })]);
    expect(r).toEqual({
      ok: false,
      error:
        '열 "예산"의 단위가 원천마다 다릅니다: a1/t1=천원(표 위 글), a2/t1=원(표 위 글). scale로 맞춘 뒤 다시 계산하세요(예: a2의 "예산"에 0.001).',
    });
    // 차원 낱말이 없는 열은 원 단위라도 숫자 예시를 주지 않는다
    const r2 = combine([
      src('a1', [['부서', '실적'], ['a', 1]], { caption: CAP_THOUSAND }),
      src('a2', [['부서', '실적'], ['b', 1000]], { caption: '(단위: 원)' }),
    ]);
    expect(r2).toEqual({
      ok: false,
      error: '열 "실적"의 단위가 원천마다 다릅니다: a1/t1=천원(표 위 글), a2/t1=원(표 위 글). scale로 맞춘 뒤 다시 계산하세요.',
    });
  });

  it('전년대비는 캡션 단위를 받지 않고 전년대비(%)와 쌓인다', () => {
    const r = ok(
      combine([src('a1', [['부서', '전년대비'], ['a', 5]], { caption: CAP_THOUSAND }), src('a2', [['부서', '전년대비(%)'], ['b', 3]])])
    );
    expect(r.columns[1]).toEqual({ name: '전년대비(%)', unit: '%', numeric: true });
    expect(r.lineage.unitWarnings).toEqual(['열 "전년대비": a1/t1은 단위를 알 수 없습니다 — 같은 단위인지 확인하세요']);
  });

  it('단위를 아는 열에 준 scale이 맞는 단위로 떨어지지 않으면 실패 — 비교할 원천이 없어도', () => {
    expect(combine([src('a1', [['부서', '예산(원)'], ['a', 12]], { spec: { scale: { 예산: 1000 } } })])).toEqual({
      ok: false,
      error: 'scale 방향/크기가 단위와 맞지 않습니다 (a1 원×1000 → 맞는 단위 없음)',
    });
    expect(
      combine([
        src('a1', [['부서', '예산(천원)'], ['a', 12]]),
        src('a2', [['부서', '예산(천원)'], ['b', 3]], { spec: { scale: { 예산: 1.5 } } }),
      ])
    ).toEqual({ ok: false, error: 'scale 방향/크기가 단위와 맞지 않습니다 (a2 천원×1.5 ≠ 천원)' });
  });

  it('명 ↔ 천명 scale: 맞는 방향은 통과, 거꾸로면 실패', () => {
    const good = ok(
      combine([
        src('a1', [['부서', '인원(명)'], ['a', 12]]),
        src('a2', [['부서', '인원(천명)'], ['b', 1.5]], { spec: { scale: { 인원: 1000 } } }),
      ])
    );
    expect(good.rows.map((row) => row[1])).toEqual([12, 1500]);
    expect(
      combine([
        src('a1', [['부서', '인원(명)'], ['a', 12]]),
        src('a2', [['부서', '인원(천명)'], ['b', 1.5]], { spec: { scale: { 인원: 0.001 } } }),
      ])
    ).toEqual({ ok: false, error: 'scale 방향/크기가 단위와 맞지 않습니다 (a2 천명×0.001 ≠ 명)' });
  });

  it('% 열의 ×100·×0.01은 실패가 아니라 경고', () => {
    const r = ok(
      combine([
        src('a1', [['부서', '비율(%)'], ['a', 0.12]], { spec: { scale: { 비율: 100 } } }),
        src('a2', [['부서', '비율(%)'], ['b', 0.03]], { spec: { scale: { 비율: 100 } } }),
      ])
    );
    expect(r.rows.map((row) => row[1])).toEqual([12, 3]);
    expect(r.columns[1]).toEqual({ name: '비율(%)', unit: '%', numeric: true });
    expect(r.lineage.unitWarnings).toEqual([
      '열 "비율": a1/t1 값을 ×100 했습니다(분수 → 백분율)',
      '열 "비율": a2/t1 값을 ×100 했습니다(분수 → 백분율)',
    ]);
    const r2 = ok(
      combine([
        src('a1', [['부서', '비율(%)'], ['a', 12]]),
        src('a2', [['부서', '비율(%)'], ['b', 0.15]], { spec: { scale: { 비율: 100 } } }),
      ])
    );
    expect(r2.rows.map((row) => row[1])).toEqual([12, 15]);
  });

  it('% 열에서 한 원천만 분수(0~1)로 적혀 있으면 경고', () => {
    const r = ok(
      combine([src('a1', [['부서', '집행률(%)'], ['a', 0.85], ['c', 0.5]]), src('a2', [['부서', '집행률(%)'], ['b', 92]])])
    );
    expect(r.lineage.unitWarnings).toEqual([
      '열 "집행률(%)": a1/t1 값이 분수(0~1)로 적힌 것 같습니다 — scale 100으로 맞추세요',
    ]);
    // 모두 분수거나 모두 백분수면 경고하지 않는다
    const same = ok(combine([src('a1', [['부서', '집행률(%)'], ['a', 85]]), src('a2', [['부서', '집행률(%)'], ['b', 92]])]));
    expect(same.lineage.unitWarnings).toEqual([]);
  });
});


describe('수정 3차 — 키성 숫자 열을 건너뛰고 첫 측정 열을 찾는다', () => {
  it('맨 앞 연도 열 뒤의 합계 행을 뺀다', () => {
    const r = ok(
      combine([src('a1', [['연도', '부서', '예산'], [2025, '총무과', 100], [2025, '기획과', 200], [2025, '합계', 300]])])
    );
    expect(r.rows.map((row) => row[2])).toEqual([100, 200]);
    expect(r.lineage.skippedRows.map((s) => [s.row, s.reason])).toEqual([[4, '합계 행']]);
  });

  it('맨 앞 부서코드 열 뒤의 합계 행을 뺀다 — 코드 칸이 채워져 있어도', () => {
    const r = ok(
      combine([src('a1', [['부서코드', '부서', '예산'], [101, '총무과', 100], [102, '기획과', 200], [999, '합계', 300]])])
    );
    expect(r.rows.map((row) => row[2])).toEqual([100, 200]);
  });

  it('연도 열 뒤 구분 열의 소계를 뺀다', () => {
    const r = ok(
      combine([
        src('a1', [
          ['연도', '구분', '예산'],
          [2024, '총무과', 100],
          [2024, '소계', 100],
          [2025, '총무과', 120],
          [2025, '소계', 120],
        ]),
      ])
    );
    expect(r.rows).toEqual([
      [2024, '총무과', 100],
      [2025, '총무과', 120],
    ]);
  });

  it('측정 열 사이의 비고는 여전히 라벨 열이 아니다', () => {
    const r = ok(
      combine([src('a1', [['부서', '예산', '비고', '결산'], ['총무과', 10, '계(추정)', 9], ['기획과', 20, '소계(포함)', 18]])])
    );
    expect(r.rows.map((row) => row[0])).toEqual(['총무과', '기획과']);
  });

  it('연도가 든 측정 열 이름(2025년)은 키 열이 아니다 — 오른쪽 비고는 라벨이 아님', () => {
    const r = ok(
      combine([src('a1', [['부서', '2024년', '2025년', '비고'], ['총무과', 10, 12, '계(추정)'], ['기획과', 20, 22, '합계']])])
    );
    expect(r.rows.map((row) => row[0])).toEqual(['총무과', '기획과']);
  });

  it('이름이 일련번호류가 아닌 1..n 열은 일련번호가 아니다 — 오른쪽 글자 열의 합계 표기는 데이터', () => {
    const r = ok(combine([src('a1', [['예산', '비고'], [1, '소계(포함)'], [2, '합계'], [3, 'a']])]));
    expect(r.rows).toEqual([
      [1, '소계(포함)'],
      [2, '합계'],
      [3, 'a'],
    ]);
    expect(r.lineage.skippedRows).toEqual([]);
  });
});

describe('수정 3차 — 병합 범위 안에 제 글이 있는 행', () => {
  it('합계 병합이 덮는 범위라도 그 칸에 다른 글이 있으면 데이터 행으로 둔다', () => {
    const r = ok(
      combine([
        src(
          'a1',
          [
            ['구분', '항목', '금액'],
            ['합계', '예산', 300],
            [null, '결산', 270],
            ['총무과', '예산', 100],
          ],
          { merges: [{ row: 1, col: 0, rows: 3, cols: 1 }] }
        ),
      ])
    );
    expect(r.rows.map((row) => row[2])).toEqual([100]);
    expect(r.lineage.skippedRows.map((s) => s.row)).toEqual([2, 3]);
  });
});

describe('수정 3차 — 키성 열 판정 갈래', () => {
  it('이름이 연도가 아니어도 값이 전부 1900~2100 정수면 키 열', () => {
    const r = ok(combine([src('a1', [['기준', '부서', '예산'], [2024, '총무과', 100], [2025, '총무과', 120], [2025, '합계', 220]])]));
    expect(r.rows.map((row) => row[2])).toEqual([100, 120]);
  });

  it('No 열은 일련번호', () => {
    const r = ok(combine([src('a1', [['No', '부서', '예산'], [1, '총무과', 100], [2, '기획과', 50], [3, '소계', 150]])]));
    expect(r.rows.map((row) => row[2])).toEqual([100, 50]);
  });

  it('이름에 숫자가 든 열은 이름 규칙으로 키 열이 되지 않는다 — 2025년도 예산', () => {
    const r = ok(
      combine([src('a1', [['부서', '2025년도 예산', '비고'], ['총무과', 10, '계(추정)'], ['기획과', 20, '합계']])])
    );
    expect(r.rows.map((row) => row[0])).toEqual(['총무과', '기획과']);
  });
});

// ── Task 3: 거르기·묶기·집계·정렬·합계 행 ─────────────────────────

const BUDGET: Cell[][] = [
  ['부서', '예산'],
  ['총무과', 100],
  ['총무과', 200],
  ['기획과', 50],
];

describe('묶기·집계', () => {
  it('부서 기준 묶어 합계·개수, 합계 행', () => {
    const r = ok(
      combine([src('a1', BUDGET)], {
        group_by: ['부서'],
        aggregate: [
          { column: '예산', fn: 'sum' },
          { column: '예산', fn: 'count' },
        ],
        total_row: true,
      })
    );
    expect(r.columns).toEqual([
      { name: '부서', unit: null, numeric: false },
      { name: '예산 합계', unit: null, numeric: true },
      { name: '예산 개수', unit: null, numeric: true },
    ]);
    expect(r.rows).toEqual([
      ['총무과', 300, 2],
      ['기획과', 50, 1],
    ]);
    expect(r.total).toEqual(['합계', 350, null]);
    expect(r.lineage.rowCounts).toEqual({ stacked: 3, filtered: 3, result: 2 });
  });

  it('읽지 못한 칸은 합계에서 빠진다(0으로 치지 않음)', () => {
    const r = ok(
      combine([src('a1', [['부서', '예산'], ['총무과', 100], ['총무과', '미제출'], ['총무과', 50]])], {
        group_by: ['부서'],
        aggregate: [
          { column: '예산', fn: 'sum' },
          { column: '예산', fn: 'avg' },
          { column: '예산', fn: 'count' },
        ],
      })
    );
    expect(r.rows).toEqual([['총무과', 150, 75, 2]]);
    expect(r.lineage.unreadable).toHaveLength(1);
  });

  it('묶음 키는 앞뒤·전각 공백만 다듬고, 가운데 공백은 다른 키 + 비슷한 키 경고', () => {
    const r = ok(
      combine(
        [
          src('a1', [['부서', '예산'], ['총무과', 100], ['총무과　', 10], [' 총무과 ', 1]]),
          src('a2', [['부서', '예산'], ['총무 과', 1000], ['기획　　과', 5], ['기획 과', 7]]),
        ],
        { group_by: ['부서'], aggregate: [{ column: '예산', fn: 'sum' }] }
      )
    );
    expect(r.rows).toEqual([
      ['총무과', 111],
      ['총무 과', 1000],
      ['기획 과', 12],
    ]);
    expect(r.lineage.similarKeys).toEqual([['총무과', '총무 과']]);
  });

  it('조합형(NFD) 글자도 같은 키로 묶는다', () => {
    const nfd = '총무과'.normalize('NFD');
    const r = ok(
      combine([src('a1', [['부서', '예산'], ['총무과', 1], [nfd, 2]])], {
        group_by: ['부서'],
        aggregate: [{ column: '예산', fn: 'sum' }],
      })
    );
    expect(r.rows).toEqual([['총무과', 3]]);
  });

  it('결과 열 이름은 as 또는 "열 함수", 단위는 원래 열 단위(개수는 없음)', () => {
    const r = ok(
      combine([src('a1', BUDGET, { caption: CAP_THOUSAND })], {
        group_by: ['부서'],
        aggregate: [
          { column: '예산', fn: 'sum', as: '총예산' },
          { column: '예산', fn: 'avg' },
          { column: '예산', fn: 'min' },
          { column: '예산', fn: 'max' },
          { column: '예산', fn: 'count' },
        ],
      })
    );
    expect(r.columns).toEqual([
      { name: '부서', unit: null, numeric: false },
      { name: '총예산', unit: '천원', numeric: true },
      { name: '예산(천원) 평균', unit: '천원', numeric: true },
      { name: '예산(천원) 최소', unit: '천원', numeric: true },
      { name: '예산(천원) 최대', unit: '천원', numeric: true },
      { name: '예산(천원) 개수', unit: null, numeric: true },
    ]);
    expect(r.rows).toEqual([
      ['총무과', 300, 150, 100, 200, 2],
      ['기획과', 50, 50, 50, 50, 1],
    ]);
  });

  it('단위 괄호를 뗀 이름으로도 열을 찾는다', () => {
    const r = ok(
      combine([src('a1', BUDGET, { caption: CAP_THOUSAND })], {
        filter: [{ column: '예산', op: '>', value: 60 }],
        aggregate: [{ column: '예산', fn: 'sum' }],
      })
    );
    expect(r.rows).toEqual([[300]]);
  });

  it('지시가 붙인 단위가 열 단위와 다르면 그 열로 맞추지 않는다', () => {
    const r = combine([src('a1', BUDGET, { caption: CAP_THOUSAND })], { aggregate: [{ column: '예산(원)', fn: 'sum' }] });
    expect(r).toEqual({ ok: false, error: '집계에 "예산(원)" 열이 없습니다. 있는 열: 부서, 예산(천원)' });
  });

  it('뗀 이름이 여러 열에 맞으면 실패', () => {
    const r = combine([src('a1', [['부서', '인원(명)', '인원(%)'], ['총무과', 3, 50]])], {
      aggregate: [{ column: '인원', fn: 'sum' }],
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain('여럿');
  });

  it('묶기 없이 집계만 있으면 한 행, 행이 없으면 합계는 null·개수는 0', () => {
    const r = ok(
      combine([src('a1', BUDGET)], {
        aggregate: [
          { column: '예산', fn: 'sum' },
          { column: '부서', fn: 'count' },
        ],
      })
    );
    expect(r.columns.map((c) => c.name)).toEqual(['예산 합계', '부서 개수']);
    expect(r.rows).toEqual([[350, 3]]);
    const empty = ok(
      combine([src('a1', BUDGET)], {
        filter: [{ column: '부서', op: '=', value: '없는과' }],
        aggregate: [
          { column: '예산', fn: 'sum' },
          { column: '예산', fn: 'count' },
        ],
      })
    );
    expect(empty.rows).toEqual([[null, 0]]);
    expect(empty.lineage.rowCounts).toEqual({ stacked: 3, filtered: 0, result: 1 });
  });

  it('묶기 없이 집계도 없으면 쌓은 행 그대로, 묶기만 있으면 서로 다른 키', () => {
    expect(ok(combine([src('a1', BUDGET)])).rows).toEqual(BUDGET.slice(1));
    expect(ok(combine([src('a1', BUDGET)], { group_by: ['부서'] })).rows).toEqual([['총무과'], ['기획과']]);
  });

  it('병합된 숫자는 묶어도 한 번만, 병합된 부서·연도 칸은 아래 행도 같은 키로', () => {
    const r = ok(
      combine(
        [
          src(
            'a1',
            [
              ['연도', '부서', '팀', '예산'],
              [2025, '총무과', 'A팀', 100],
              [null, null, 'B팀', null],
              [2026, '기획과', 'C팀', 30],
            ],
            {
              merges: [
                { row: 1, col: 0, rows: 2, cols: 1 },
                { row: 1, col: 1, rows: 2, cols: 1 },
                { row: 1, col: 3, rows: 2, cols: 1 },
              ],
            }
          ),
        ],
        {
          group_by: ['연도', '부서'],
          aggregate: [
            { column: '예산', fn: 'sum' },
            { column: '팀', fn: 'count' },
          ],
        }
      )
    );
    expect(r.rows).toEqual([
      [2025, '총무과', 100, 2],
      [2026, '기획과', 30, 1],
    ]);
  });

  it('글자 열 합계는 실패', () => {
    const r = combine([src('a1', BUDGET)], { aggregate: [{ column: '부서', fn: 'sum' }] });
    expect(r).toEqual({ ok: false, error: '"부서"는 숫자 열이 아니라 합계를 낼 수 없습니다' });
    const avg = combine([src('a1', BUDGET)], { aggregate: [{ column: '부서', fn: 'avg' }] });
    expect(avg).toEqual({ ok: false, error: '"부서"는 숫자 열이 아니라 평균을 낼 수 없습니다' });
  });

  it('읽지 못한 값이 많아 글자 열로 둔 열의 합계는 실패하고 개수를 알린다', () => {
    const r = combine([src('a1', [['부서', '예산'], ['총무과', 100], ['기획과', '미제출'], ['인사과', '검토중']])], {
      aggregate: [{ column: '예산', fn: 'sum' }],
    });
    expect(r).toEqual({
      ok: false,
      error: '"예산"는 숫자 열이 아니라 합계를 낼 수 없습니다(숫자로 읽힌 값 1개, 읽지 못한 값 2개)',
    });
  });

  it('비율 열을 명시해 더하면 계산하되 경고, 평균은 단순 평균 경고', () => {
    const r = ok(
      combine([src('a1', [['부서', '집행률(%)'], ['총무과', 50], ['총무과', 70]])], {
        group_by: ['부서'],
        aggregate: [
          { column: '집행률(%)', fn: 'sum' },
          { column: '집행률(%)', fn: 'avg' },
        ],
      })
    );
    expect(r.rows).toEqual([['총무과', 120, 60]]);
    expect(r.lineage.columnWarnings).toEqual([
      '열 "집행률(%)": 비율을 더했습니다 — 합계가 의미 없을 수 있습니다',
      '열 "집행률(%)": 비율의 단순 평균입니다 — 가중 평균이 아닙니다',
    ]);
  });

  it('연도 열을 명시해 더하면 경고한다', () => {
    const r = ok(
      combine([src('a1', [['연도', '예산'], [2024, 1], [2025, 2]])], { aggregate: [{ column: '연도', fn: 'sum' }] })
    );
    expect(r.rows).toEqual([[4049]]);
    expect(r.lineage.columnWarnings).toEqual([
      '열 "연도": 연도·코드·번호로 보이는 열을 더했습니다 — 합계가 의미 없을 수 있습니다',
    ]);
  });

  it('모르는 집계 함수·결과 열 이름 겹침은 실패', () => {
    const bad = combine([src('a1', BUDGET)], { aggregate: [{ column: '예산', fn: 'median' }] });
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(bad.error).toContain('median');
    const dup = combine([src('a1', BUDGET)], {
      group_by: ['부서'],
      aggregate: [{ column: '예산', fn: 'sum', as: '부서' }],
    });
    expect(dup.ok).toBe(false);
    if (!dup.ok) expect(dup.error).toContain('"부서"');
  });
});

describe('거르기', () => {
  const TABLE: Cell[][] = [
    ['구분', '부서', '예산'],
    ['사업비', '총무과', 100],
    ['인건비', '총무과', 1000],
    ['사업비', '기획과', 50],
    ['기타 사업비', '기획과', '미제출'],
  ];

  it('거르기: 숫자 비교·contains', () => {
    const big = ok(combine([src('a1', TABLE)], { filter: [{ column: '예산', op: '>=', value: '100' }] }));
    expect(big.rows.map((r) => r[2])).toEqual([100, 1000]);
    expect(big.lineage.rowCounts).toEqual({ stacked: 4, filtered: 2, result: 2 });
    // 글자 '1,000'도 숫자로 읽어 비교 — 글자 비교면 '1,000' < '50'
    const lt = ok(combine([src('a1', TABLE)], { filter: [{ column: '예산', op: '<', value: '1,000' }] }));
    expect(lt.rows.map((r) => r[2])).toEqual([100, 50]);
    const has = ok(combine([src('a1', TABLE)], { filter: [{ column: '구분', op: 'contains', value: '사업' }] }));
    expect(has.rows.map((r) => r[0])).toEqual(['사업비', '사업비', '기타 사업비']);
    const eq = ok(
      combine([src('a1', TABLE)], {
        filter: [
          { column: '구분', op: '=', value: ' 사업비 ' },
          { column: '부서', op: '!=', value: '기획과' },
        ],
      })
    );
    expect(eq.rows).toEqual([['사업비', '총무과', 100]]);
  });

  it('없는 열이면 실제 열 목록과 함께 실패', () => {
    const r = combine([src('a1', TABLE)], { filter: [{ column: '부서명', op: '=', value: '총무과' }] });
    expect(r).toEqual({ ok: false, error: '거르기에 "부서명" 열이 없습니다. 있는 열: 구분, 부서, 예산' });
  });

  it('모르는 비교 기호는 실패, 숫자 열을 글자로 크기 비교하면 실패', () => {
    const op = combine([src('a1', TABLE)], { filter: [{ column: '예산', op: '~', value: 1 }] });
    expect(op.ok).toBe(false);
    const text = combine([src('a1', TABLE)], { filter: [{ column: '예산', op: '>', value: '많음' }] });
    expect(text.ok).toBe(false);
    if (!text.ok) expect(text.error).toContain('숫자');
  });

  it('거르기 값의 단위가 열 단위와 다르면 실패 — 1억원을 1로 비교하지 않는다', () => {
    const r = combine([src('a1', BUDGET, { caption: CAP_THOUSAND })], { filter: [{ column: '예산', op: '>=', value: '1억원' }] });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain('단위');
    const same = ok(combine([src('a1', BUDGET, { caption: CAP_THOUSAND })], { filter: [{ column: '예산', op: '>=', value: '100천원' }] }));
    expect(same.rows.map((row) => row[1])).toEqual([100, 200]);
  });

  it('병합된 연도(숫자) 칸 아래 행도 거르기에 걸린다 — 집계용 값은 비어 있어도', () => {
    const r = ok(
      combine(
        [
          src('a1', [['연도', '분기', '예산'], [2025, '1분기', 10], [null, '2분기', 20], [2026, '1분기', 30]], {
            merges: [{ row: 1, col: 0, rows: 2, cols: 1 }],
          }),
        ],
        { filter: [{ column: '연도', op: '=', value: 2025 }], aggregate: [{ column: '예산', fn: 'sum' }] }
      )
    );
    expect(r.rows).toEqual([[30]]);
  });

  it('빈 칸은 != 에만 걸린다', () => {
    const r = ok(
      combine([src('a1', [['부서', '구분', '예산'], ['총무과', '사업비', 1], ['기획과', null, 2]])], {
        filter: [{ column: '구분', op: '!=', value: '사업비' }],
      })
    );
    expect(r.rows).toEqual([['기획과', null, 2]]);
  });

  it('병합된 부서 칸 아래 행도 거르기에 걸린다(키용 행)', () => {
    const r = ok(
      combine(
        [
          src('a1', [['부서', '예산'], ['총무과', 100], [null, 20], ['기획과', 5]], {
            merges: [{ row: 1, col: 0, rows: 2, cols: 1 }],
          }),
        ],
        { filter: [{ column: '부서', op: '=', value: '총무과' }], aggregate: [{ column: '예산', fn: 'sum' }] }
      )
    );
    expect(r.rows).toEqual([[120]]);
  });
});

describe('정렬', () => {
  const ROWS: Cell[][] = [['부서', '예산'], ['총무과', 100], ['기획과', null], ['인사과', 1000], ['감사과', 50]];

  it('정렬: 숫자 큰 순, null은 뒤', () => {
    const r = ok(combine([src('a1', ROWS)], { sort: [{ column: '예산', desc: true }] }));
    expect(r.rows.map((row) => row[0])).toEqual(['인사과', '총무과', '감사과', '기획과']);
    const asc = ok(combine([src('a1', ROWS)], { sort: [{ column: '예산' }] }));
    expect(asc.rows.map((row) => row[0])).toEqual(['감사과', '총무과', '인사과', '기획과']);
  });

  it('여러 기준, 글자는 가나다순', () => {
    const r = ok(
      combine([src('a1', [['부서', '예산'], ['총무과', 1], ['기획과', 2], ['감사과', 1], ['기획과', 1]])], {
        sort: [{ column: '부서' }, { column: '예산', desc: true }],
      })
    );
    expect(r.rows).toEqual([
      ['감사과', 1],
      ['기획과', 2],
      ['기획과', 1],
      ['총무과', 1],
    ]);
  });

  it('집계 결과 열 이름으로, 또는 원래 열 이름으로 정렬한다', () => {
    const spec = { group_by: ['부서'], aggregate: [{ column: '예산', fn: 'sum' }] };
    const byResult = ok(combine([src('a1', BUDGET)], { ...spec, sort: [{ column: '예산 합계' }] }));
    expect(byResult.rows).toEqual([
      ['기획과', 50],
      ['총무과', 300],
    ]);
    const bySource = ok(combine([src('a1', BUDGET)], { ...spec, sort: [{ column: '예산' }] }));
    expect(bySource.rows).toEqual(byResult.rows);
  });
});

describe('합계 행', () => {
  it('집계 없이: 숫자 열을 더하되 연도·번호·비율 열은 빼고, 첫 글자 열에 합계', () => {
    const r = ok(
      combine(
        [
          src('a1', [
            ['연번', '연도', '부서', '2024년', '예산', '집행률(%)', '사업코드'],
            [1, 2024, '총무과', 10, 100, 50, 1001],
            [2, 2025, '기획과', 20, 200, 70, 1002],
          ]),
        ],
        { total_row: true }
      )
    );
    expect(r.total).toEqual([null, null, '합계', 30, 300, null, null]);
  });

  it('집계 없이: 값이 전부 연도인 열, 단위가 년·일·점인 열은 더하지 않는다', () => {
    const r = ok(
      combine(
        [
          src('a1', [
            ['부서', '기준', '근속', '휴가', '평가', '인원'],
            ['총무과', 2024, '3년', '2일', '80점', 5],
            ['기획과', 2025, '4년', '1일', '90점', 3],
          ]),
        ],
        { total_row: true }
      )
    );
    expect(r.total).toEqual(['합계', null, null, null, null, 8]);
  });

  it('집계 없이: 단위가 없어도 이름이 비율(…률·비중)이면 더하지 않는다', () => {
    const r = ok(
      combine([src('a1', [['부서', '예산', '집행률', '비중'], ['총무과', 10, 50, 30], ['기획과', 20, 70, 40]])], {
        total_row: true,
      })
    );
    expect(r.total).toEqual(['합계', 30, null, null]);
  });

  it('집계 없이: 이름에 연도 낱말이 있어도 측정 낱말이 있으면 더한다 — 전년도 예산', () => {
    const r = ok(
      combine([src('a1', [['부서', '전년도 예산', '금년도 예산'], ['총무과', 10, 20], ['기획과', 1, 2]])], {
        total_row: true,
      })
    );
    expect(r.total).toEqual(['합계', 11, 22]);
  });

  it('집계했으면 합계 열만 더하고 개수·평균·최소·최대는 null', () => {
    const r = ok(
      combine([src('a1', BUDGET)], {
        group_by: ['부서'],
        aggregate: [
          { column: '예산', fn: 'sum' },
          { column: '예산', fn: 'avg' },
          { column: '예산', fn: 'min' },
          { column: '예산', fn: 'max' },
          { column: '예산', fn: 'count' },
        ],
        total_row: true,
      })
    );
    expect(r.total).toEqual(['합계', 350, null, null, null, null]);
  });

  it('병합된 숫자는 합계 행에서도 한 번만', () => {
    const r = ok(
      combine(
        [
          src('a1', [['부서', '팀', '예산'], ['총무과', 'A팀', 100], [null, 'B팀', null], ['기획과', 'C팀', 30]], {
            merges: [{ row: 1, col: 2, rows: 2, cols: 1 }],
          }),
        ],
        { total_row: true }
      )
    );
    expect(r.total).toEqual(['합계', null, 130]);
  });

  it('0.1 + 0.2 = 0.3', () => {
    const r = ok(
      combine([src('a1', [['부서', '예산'], ['총무과', 0.1], ['총무과', 0.2], ['기획과', 0.7]])], {
        group_by: ['부서'],
        aggregate: [
          { column: '예산', fn: 'sum' },
          { column: '예산', fn: 'avg' },
        ],
        total_row: true,
      })
    );
    expect(r.rows).toEqual([
      ['총무과', 0.3, 0.15],
      ['기획과', 0.7, 0.7],
    ]);
    expect(r.total).toEqual(['합계', 1, null]);
    const plain = ok(combine([src('a1', [['부서', '예산'], ['총무과', 0.1], ['기획과', 0.2]])], { total_row: true }));
    expect(plain.total).toEqual(['합계', 0.3]);
  });

  it('total_row가 없으면 null', () => {
    const r = ok(combine([src('a1', BUDGET)], { group_by: ['부서'], aggregate: [{ column: '예산', fn: 'sum' }] }));
    expect(r.total).toBeNull();
  });
});

describe('결과 상한', () => {
  it('5,000행 초과는 자르고 truncated', () => {
    const cells: Cell[][] = [['부서', '예산']];
    for (let i = 0; i < 5001; i += 1) cells.push([`과${i}`, 1]);
    const r = ok(combine([src('a1', cells)], { total_row: true, sort: [{ column: '부서' }] }));
    expect(r.rows).toHaveLength(5000);
    expect(r.lineage.truncated).toBe(true);
    expect(r.lineage.rowCounts).toEqual({ stacked: 5001, filtered: 5001, result: 5001 });
    // 합계는 자르기 전 전체 행으로 — 보이는 행만 더하면 틀린 합계가 된다
    expect(r.total).toEqual(['합계', 5001]);
    expect(ok(combine([src('a1', cells.slice(0, 5001))])).lineage.truncated).toBe(false);
  });
});
