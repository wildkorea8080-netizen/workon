import { describe, it, expect } from 'vitest';
import ExcelJS from 'exceljs';
import { buildResultWorkbook } from '@/lib/xlsx-export';
import type { Lineage, ResultColumn } from '@/lib/table-engine/types';

function emptyLineage(over: Partial<Lineage> = {}): Lineage {
  return {
    sources: [],
    renamed: [],
    scaled: [],
    skippedRows: [],
    unreadable: [],
    mergedNumbers: [],
    onlyIn: [],
    unitWarnings: [],
    parenthesizedNegatives: [],
    columnWarnings: [],
    similarKeys: [],
    notes: [],
    rowCounts: { stacked: 0, filtered: 0, result: 0 },
    truncated: false,
    ...over,
  };
}

const COLS: ResultColumn[] = [
  { name: '부서', unit: null, unitSource: null, numeric: false },
  { name: '예산(천원)', unit: '천원', unitSource: 'name', numeric: true },
  { name: '비율', unit: null, unitSource: null, numeric: true },
];

async function load(buf: Buffer) {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buf as unknown as ArrayBuffer);
  return wb;
}

function sheetText(ws: ExcelJS.Worksheet): string[] {
  const out: string[] = [];
  ws.eachRow((row) => {
    row.eachCell((cell) => {
      out.push(String(cell.value ?? ''));
    });
  });
  return out;
}

const BASE = {
  title: '부서별 예산',
  columns: COLS,
  rows: [
    ['총무과', 1000, 0.5],
    ['기획과', 2000, 1],
  ] as (string | number | null)[][],
  total: ['합계', 3000, null] as (string | number | null)[],
  lineage: emptyLineage({ rowCounts: { stacked: 2, filtered: 2, result: 2 } }),
  specSentences: ['예산.xlsx 표 1을 합친다.'],
  createdAt: new Date(Date.UTC(2026, 9, 21, 15, 5)), // KST 2026-10-22 00:05
};

describe('buildResultWorkbook', () => {
  it('결과·계산 근거 두 시트', async () => {
    const wb = await load(await buildResultWorkbook(BASE));
    expect(wb.worksheets.map((w) => w.name)).toEqual(['결과', '계산 근거']);
    const ws = wb.getWorksheet('결과')!;
    expect(ws.getRow(1).values).toEqual([undefined, '부서', '예산(천원)', '비율']);
    expect(ws.getCell('A2').value).toBe('총무과');
    expect(ws.getCell('B3').value).toBe(2000);
    expect(ws.getCell('A4').value).toBe('합계');
    expect(ws.getCell('B4').value).toBe(3000);
  });

  it('숫자 서식·머리글 고정·합계 행 굵게', async () => {
    const ws = (await load(await buildResultWorkbook(BASE))).getWorksheet('결과')!;
    expect(ws.views[0]).toMatchObject({ state: 'frozen', ySplit: 1 });
    expect(ws.getRow(1).font?.bold).toBe(true);
    expect(ws.getCell('B2').numFmt).toBe('#,##0'); // 정수 열
    expect(ws.getCell('C2').numFmt).toBe('#,##0.0'); // 소수가 있는 열 — 최대 자릿수에 맞춤
    expect(ws.getCell('A2').numFmt).not.toBe('#,##0');
    expect(ws.getRow(4).font?.bold).toBe(true);
    expect(ws.getRow(2).font?.bold).toBeFalsy();
    // 한글은 두 칸으로 센다 — 최소 8
    expect(ws.getColumn(1).width).toBeGreaterThanOrEqual(8);
    expect(ws.getColumn(2).width).toBeGreaterThan(8);
  });

  it('열 너비는 최대 50', async () => {
    const long = '가'.repeat(80);
    const ws = (
      await load(await buildResultWorkbook({ ...BASE, rows: [[long, 1, 1]], total: null }))
    ).getWorksheet('결과')!;
    expect(ws.getColumn(1).width).toBe(50);
  });

  it('값은 수식이 아니다', async () => {
    const wb = await load(await buildResultWorkbook(BASE));
    for (const ws of wb.worksheets) {
      ws.eachRow((row) =>
        row.eachCell((cell) => {
          expect(cell.formula).toBeUndefined();
          expect(typeof cell.value === 'object' && cell.value !== null && 'formula' in cell.value).toBe(false);
        }),
      );
    }
  });

  it('수식 주입 글자는 글자로 — 결과 시트의 칸·머리글·합계', async () => {
    const cols: ResultColumn[] = [
      { name: '=HYPERLINK("http://x")', unit: null, unitSource: null, numeric: false },
      { name: '값', unit: null, unitSource: null, numeric: true },
    ];
    const wb = await load(
      await buildResultWorkbook({
        ...BASE,
        columns: cols,
        rows: [
          ['=HYPERLINK("http://x")', 1],
          ['+1', 2],
          ['@SUM(A1)', 3],
          ['-x', 4],
          ['정상', -5], // 음수 숫자는 그대로 숫자
        ],
        total: ['=합계', 5],
      }),
    );
    const ws = wb.getWorksheet('결과')!;
    expect(ws.getCell('A1').value).toBe(`'=HYPERLINK("http://x")`);
    expect(ws.getCell('A2').value).toBe(`'=HYPERLINK("http://x")`);
    expect(ws.getCell('A3').value).toBe("'+1");
    expect(ws.getCell('A4').value).toBe("'@SUM(A1)");
    expect(ws.getCell('A5').value).toBe("'-x");
    expect(ws.getCell('A6').value).toBe('정상');
    expect(ws.getCell('B6').value).toBe(-5);
    expect(ws.getCell('A7').value).toBe("'=합계");
  });

  it('수식 주입 글자는 글자로 — 근거 시트(파일 이름·지시·뺀 행 글)', async () => {
    const lineage = emptyLineage({
      sources: [
        {
          file: 'a1',
          fileName: '=cmd|evil.xlsx',
          table: 't1',
          title: '+제목',
          headerRows: [1, 1],
          rowsIn: 3,
          rowsUsed: 2,
        },
      ],
      skippedRows: [{ file: 'a1', table: 't1', row: 4, reason: '합계 행', text: '@합계' }],
      notes: ['-안내'],
    });
    const wb = await load(
      await buildResultWorkbook({ ...BASE, lineage, specSentences: ['=지시'] }),
    );
    const text = sheetText(wb.getWorksheet('계산 근거')!);
    expect(text).toContain("'=cmd|evil.xlsx");
    expect(text).toContain("'+제목");
    expect(text).toContain("'@합계");
    expect(text).toContain("'-안내");
    expect(text).toContain("'=지시");
    for (const t of text) expect(/^[=+\-@]/.test(t)).toBe(false);
  });

  it('근거 시트에 뺀 행·읽지 못한 칸·지시 문장', async () => {
    const lineage = emptyLineage({
      sources: [
        { file: 'a1', fileName: '예산.xlsx', table: 't1', title: '예산표', headerRows: [1, 2], rowsIn: 10, rowsUsed: 8 },
      ],
      renamed: [{ file: 'a1', from: '사업명', to: '사업' }],
      scaled: [{ file: 'a1', column: '예산(천원)', factor: 0.001 }],
      skippedRows: [{ file: 'a1', table: 't1', row: 11, reason: '합계 행', text: '합계' }],
      unreadable: [
        { file: 'a1', table: 't1', row: 5, column: '예산(천원)', text: '미정' },
        { file: 'a1', table: 't1', row: 6, column: '예산(천원)', text: '30%', reason: '단위가 맞지 않음' },
      ],
      mergedNumbers: [{ file: 'a1', table: 't1', row: 3, rowEnd: 5, column: '예산(천원)' }],
      onlyIn: [{ column: '비고', files: ['a1/t1'] }],
      unitWarnings: ['단위 경고 문장'],
      parenthesizedNegatives: ['증감'],
      columnWarnings: ['열 경고 문장'],
      similarKeys: [['총무과', '총무 과']],
      notes: ['합계 행은 전체 5,003행 기준 — 표에는 5,000행만'],
      rowCounts: { stacked: 8, filtered: 8, result: 5003 },
      truncated: true,
    });
    const wb = await load(await buildResultWorkbook({ ...BASE, lineage }));
    const ws = wb.getWorksheet('계산 근거')!;
    const text = sheetText(ws);
    const joined = text.join('\n');
    expect(joined).toContain('만든 때');
    expect(text).toContain('2026-10-22 00:05'); // KST
    expect(text).toContain('예산.xlsx 표 1을 합친다.');
    expect(text).toContain('합계 행은 전체 5,003행 기준 — 표에는 5,000행만');
    expect(text).toContain('합계 행'); // 뺀 이유
    expect(text).toContain('미정');
    expect(text).toContain('30%');
    expect(text).toContain('단위가 맞지 않음');
    expect(text).toContain('0.001');
    expect(text).toContain('사업명');
    expect(joined).toContain('비고');
    expect(text).toContain('단위 경고 문장');
    expect(text).toContain('열 경고 문장');
    expect(joined).toContain('증감');
    expect(joined).toContain('총무과, 총무 과');
    expect(joined).toContain('결과 5,003');
    // 안내는 만든 때 바로 아래
    const rowOf = (needle: string) => {
      let found = -1;
      ws.eachRow((row, n) => {
        row.eachCell((c) => {
          if (String(c.value ?? '').includes(needle) && found < 0) found = n;
        });
      });
      return found;
    };
    expect(rowOf('합계 행은 전체')).toBeLessThan(rowOf('예산.xlsx 표 1을'));
    expect(rowOf('합계 행은 전체')).toBeGreaterThan(rowOf('2026-10-22'));
  });

  it('숫자 서식은 열의 최대 소수 자릿수로 — 합계 행 포함, 행 순서와 무관', async () => {
    const cols: ResultColumn[] = [
      { name: '이름', unit: null, unitSource: null, numeric: false },
      { name: 'a', unit: null, unitSource: null, numeric: true },
      { name: 'b', unit: null, unitSource: null, numeric: true },
      { name: 'c', unit: null, unitSource: null, numeric: true },
    ];
    const mk = (rows: number[][]) =>
      buildResultWorkbook({
        ...BASE,
        columns: cols,
        rows: rows.map((r) => ['x', ...r]),
        total: ['합계', 0, 0, 0.25],
      });
    const ws = (await load(await mk([[12.5, 1, 3], [3, 2, 5], [5, 3, 7], [0.001234, 4, 9]]))).getWorksheet('결과')!;
    for (const r of [2, 3, 4, 5]) expect(ws.getCell(`B${r}`).numFmt).toBe('#,##0.0000'); // 3도 3.0000
    expect(ws.getCell('C2').numFmt).toBe('#,##0');
    expect(ws.getCell('D2').numFmt).toBe('#,##0.00'); // 합계 행의 0.25가 열 서식을 정한다
    const w1 = ws.getColumn(2).width!;
    const rev = (await load(await mk([[0.001234, 1, 3], [5, 2, 5], [3, 3, 7], [12.5, 4, 9]]))).getWorksheet('결과')!;
    expect(rev.getColumn(2).width).toBe(w1);
    expect(rev.getCell('B2').numFmt).toBe('#,##0.0000');
    const two = (await load(await mk([[12.5, 1, 3], [3, 2, 5]]))).getWorksheet('결과')!;
    expect(two.getCell('B2').numFmt).toBe('#,##0.0');
  });

  it('홑 줄표는 값 없음 표시라 그대로 둔다', async () => {
    const ws = (
      await load(await buildResultWorkbook({ ...BASE, rows: [['-', 1, 1], ['—', 2, 1], ['-x', 3, 1]], total: null }))
    ).getWorksheet('결과')!;
    expect(ws.getCell('A2').value).toBe('-');
    expect(ws.getCell('A3').value).toBe('—');
    expect(ws.getCell('A4').value).toBe("'-x");
  });

  it('칸 글은 32,000자에서 자른다', async () => {
    const ws = (
      await load(await buildResultWorkbook({ ...BASE, rows: [['가'.repeat(40000), 1, 1]], total: null }))
    ).getWorksheet('결과')!;
    expect(ws.getCell('A2').value).toBe('가'.repeat(32000) + '…');
  });

  it('문서 속성 제목에는 작은따옴표를 붙이지 않는다', async () => {
    const wb = await load(await buildResultWorkbook({ ...BASE, title: '=표 제목' }));
    expect(wb.title).toBe('=표 제목');
  });

  it('비어 있는 항목은 없음', async () => {
    const wb = await load(await buildResultWorkbook(BASE));
    const text = sheetText(wb.getWorksheet('계산 근거')!);
    expect(text.filter((t) => t === '없음').length).toBeGreaterThanOrEqual(5);
  });
});
