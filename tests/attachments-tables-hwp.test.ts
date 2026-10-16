import { describe, it, expect } from 'vitest';
import { readHwpxTables } from '@/lib/attachments/tables-hwpx';
import { extractHwpTables, extractTextFromHwp } from '@/lib/hwp';
import { MAX_TABLE_COLS } from '@/lib/attachments/limits';
import { buildHwpx, para as xpara, tableAt, secPrPara, emptyPara } from './fixtures/hwpx';
import { buildHwp, para, tablePara, type HwpTable } from './fixtures/hwp5';

/**
 * 계산용 한글 표 읽기. 한글 표 칸은 전부 글자, 빈 칸은 null.
 * 핵심은 "조용히 틀리지 않는가" — 안쪽 표의 글이 바깥 칸에 섞이거나
 * 병합 칸이 밀리면 합계가 틀린다. 색인(extractTextFromHwp) 출력은 한 글자도 바뀌지 않는다.
 */

/** 칸 하나: 주소·병합을 달 수 있는 HWPX 칸 */
function tc(text: string | string[], addr?: { r: number; c: number; rs?: number; cs?: number }, inner = ''): string {
  const paras = (Array.isArray(text) ? text : [text]).map((t) => (t === '' ? emptyPara('7') : xpara(t, '7'))).join('');
  const a = addr
    ? `<hp:cellAddr colAddr="${addr.c}" rowAddr="${addr.r}"/><hp:cellSpan colSpan="${addr.cs ?? 1}" rowSpan="${addr.rs ?? 1}"/>`
    : '';
  return `<hp:tc><hp:subList>${paras}${inner}</hp:subList>${a}<hp:cellSz width="1000" height="282"/></hp:tc>`;
}

function tbl(rows: string[]): string {
  return `<hp:p id="2" paraPrIDRef="0" styleIDRef="0"><hp:run charPrIDRef="0"><hp:tbl id="9" rowCnt="${rows.length}" colCnt="2">${rows
    .map((r) => `<hp:tr>${r}</hp:tr>`)
    .join('')}</hp:tbl><hp:t/></hp:run></hp:p>`;
}

describe('HWPX 표 읽기', () => {
  it('HWPX 표를 칸 배열로 — 주소·병합·여러 줄 칸', async () => {
    const body =
      secPrPara() +
      tbl([
        tc('구분', { r: 0, c: 0, cs: 2 }),
        tc('항목', { r: 1, c: 0 }) + tc('금액', { r: 1, c: 1 }),
        tc(['가', '나'], { r: 2, c: 0 }) + tc('1,200', { r: 2, c: 1 }),
        tc('다', { r: 3, c: 0 }) + tc('', { r: 3, c: 1 }),
      ]);
    const { tables, warnings } = await readHwpxTables(await buildHwpx(body));
    expect(warnings).toEqual([]);
    expect(tables).toHaveLength(1);
    const t = tables[0];
    expect(t.id).toBe('t1');
    expect(t.title).toBe('표 1');
    expect(t.cells).toEqual([
      ['구분', null],
      ['항목', '금액'],
      ['가\n나', '1,200'],
      ['다', null],
    ]);
    expect(t.merges).toEqual([{ row: 0, col: 0, rows: 1, cols: 2 }]);
    expect(t.header).toEqual({ from: 1, to: 1 });
    expect(t.columns).toEqual(['항목', '금액']);
  });

  it('주소가 없으면 행 순번·행 안 순서, 글자 이스케이프는 푼다', async () => {
    const body = tableAt([
      ['이름', '비고'],
      ['A &amp; B', '&lt;확인&gt;'],
    ]);
    const { tables } = await readHwpxTables(await buildHwpx(body));
    expect(tables[0].cells).toEqual([
      ['이름', '비고'],
      ['A & B', '<확인>'],
    ]);
  });

  it('HWPX 안쪽 표는 따로, 바깥 칸 글에서 빠진다', async () => {
    const inner = tbl([tc('안1', { r: 0, c: 0 }) + tc('안2', { r: 0, c: 1 }), tc('3', { r: 1, c: 0 }) + tc('4', { r: 1, c: 1 })]);
    const body = tbl([
      tc('바깥', { r: 0, c: 0 }) + tc('값', { r: 0, c: 1 }),
      tc('칸 글', { r: 1, c: 0 }, inner) + tc('9', { r: 1, c: 1 }),
    ]);
    const { tables } = await readHwpxTables(await buildHwpx(body));
    expect(tables).toHaveLength(2);
    // 문서 순서 = 표가 시작하는 순서: 바깥 표가 먼저
    expect(tables.map((t) => t.title)).toEqual(['표 1', '표 2']);
    expect(tables[0].cells).toEqual([
      ['바깥', '값'],
      ['칸 글', '9'],
    ]);
    expect(tables[1].id).toBe('t2');
    expect(tables[1].cells).toEqual([
      ['안1', '안2'],
      ['3', '4'],
    ]);
  });

  it('칸 문단 안의 글상자 글은 칸 글이 아니다 — 바로 든 문단만', async () => {
    const box = `<hp:p id="3" paraPrIDRef="0" styleIDRef="0"><hp:run charPrIDRef="0"><hp:rect><hp:drawText><hp:subList>${xpara('글상자')}</hp:subList></hp:drawText></hp:rect><hp:t>본문</hp:t></hp:run></hp:p>`;
    const body = tbl([tc('항목', { r: 0, c: 0 }) + tc('값', { r: 0, c: 1 }), tc('', { r: 1, c: 0 }, box) + tc('7', { r: 1, c: 1 })]);
    const { tables } = await readHwpxTables(await buildHwpx(body));
    expect(tables[0].cells[1]).toEqual(['본문', '7']);
  });

  it('칸 안의 탭·줄바꿈은 글로 남는다', async () => {
    const p = `<hp:p id="1" paraPrIDRef="7" styleIDRef="0"><hp:run charPrIDRef="0"><hp:t>가<hp:tab/>나<hp:lineBreak/>다</hp:t></hp:run></hp:p>`;
    const body = tbl([tc('a', { r: 0, c: 0 }) + tc('b', { r: 0, c: 1 }), tc('', { r: 1, c: 0 }, p) + tc('1', { r: 1, c: 1 })]);
    const { tables } = await readHwpxTables(await buildHwpx(body));
    expect(tables[0].cells[1][0]).toBe('가\t나\n다');
  });

  it('HWPX caption은 표 앞 문단 — (단위: 천원)', async () => {
    const body =
      secPrPara() +
      xpara('1. 예산 현황') +
      xpara('(단위: 천원)') +
      emptyPara() +
      tableAt([
        ['사업', '예산'],
        ['A', '100'],
      ]) +
      // 표 바로 뒤에 붙은 표는 앞 표의 caption을 물려받지 않는다
      tableAt([
        ['사업', '집행'],
        ['A', '50'],
      ]) +
      xpara('(단위: 원)') +
      tableAt([
        ['x', 'y'],
        ['1', '2'],
      ]);
    const { tables } = await readHwpxTables(await buildHwpx(body));
    expect(tables.map((t) => t.caption)).toEqual(['(단위: 천원)', undefined, '(단위: 원)']);
  });

  it('구역이 여럿이면 구역 순서대로 번호를 잇는다', async () => {
    const a = tableAt([['a', 'b'], ['1', '2']]);
    const b = tableAt([['c', 'd'], ['3', '4']]);
    const { tables } = await readHwpxTables(await buildHwpx(a, { moreSections: [b] }));
    expect(tables.map((t) => [t.id, t.title, t.cells[0][0]])).toEqual([
      ['t1', '표 1', 'a'],
      ['t2', '표 2', 'c'],
    ]);
  });

  it('열 상한을 넘으면 잘라 읽고 경고를 남긴다', async () => {
    const width = MAX_TABLE_COLS + 5;
    const row = (p: string) => Array.from({ length: width }, (_, i) => `${p}${i}`);
    const { tables, warnings } = await readHwpxTables(await buildHwpx(tableAt([row('h'), row('v')], { addr: true })));
    expect(tables[0].cells[0]).toHaveLength(MAX_TABLE_COLS);
    expect(tables[0].truncated).toEqual({ cols: width });
    expect(warnings).toEqual([`표 1: 열 ${width.toLocaleString('ko-KR')}개 중 ${MAX_TABLE_COLS.toLocaleString('ko-KR')}개만 읽었습니다`]);
  });

  it('표가 없으면 빈 목록', async () => {
    const { tables, warnings } = await readHwpxTables(await buildHwpx(xpara('본문뿐')));
    expect(tables).toEqual([]);
    expect(warnings).toEqual([]);
  });
});

/** 색인 출력 고정용 문서: 제목·단위 줄, 병합·여러 문단 칸·안쪽 표·파이프 글자를 품은 표 */
const INNER: HwpTable = {
  rows: 1,
  cols: 2,
  cells: [
    { row: 0, col: 0, paras: ['안a'] },
    { row: 0, col: 1, paras: ['안b'] },
  ],
};
const OUTER: HwpTable = {
  rows: 4,
  cols: 3,
  cells: [
    { row: 0, col: 0, colSpan: 2, paras: ['구분'] },
    { row: 0, col: 2, rowSpan: 2, paras: ['합계'] },
    { row: 1, col: 0, paras: ['본예산'] },
    { row: 1, col: 1, paras: ['추경'] },
    { row: 2, col: 0, paras: ['1,000', '(확정)'] },
    { row: 2, col: 1, paras: ['A|B'] },
    { row: 2, col: 2, paras: [''] },
    { row: 3, col: 0, paras: ['비고', { table: INNER }] },
    { row: 3, col: 1, paras: ['x'] },
    { row: 3, col: 2, paras: ['y'] },
  ],
};
const sample = () =>
  buildHwp([...para('1. 예산 현황'), ...para('(단위: 천원)'), ...tablePara(OUTER), ...para('끝 문단')]);

describe('HWP 5.0 표 읽기', () => {
  it('HWP 5.0 표 칸 배열과 병합', () => {
    const tables = extractHwpTables(sample());
    expect(tables).toHaveLength(2);
    expect(tables[0].cells).toEqual([
      ['구분', null, '합계'],
      ['본예산', '추경', null],
      ['1,000\n(확정)', 'A|B', null],
      ['비고', 'x', 'y'],
    ]);
    expect(tables[0].merges).toEqual([
      { row: 0, col: 0, rows: 1, cols: 2 },
      { row: 0, col: 2, rows: 2, cols: 1 },
    ]);
    expect(tables[0].caption).toBe('(단위: 천원)');
    // 안쪽 표는 따로, 바깥 표 다음
    expect(tables[1].cells).toEqual([['안a', '안b']]);
    expect(tables[1].caption).toBe('(단위: 천원)');
  });

  it('행 상한 500을 넘는 표도 글로 떨어지지 않고 칸 배열이 된다', () => {
    const rows = 600;
    const t: HwpTable = {
      rows,
      cols: 2,
      cells: Array.from({ length: rows }, (_, r) => [
        { row: r, col: 0, paras: [r === 0 ? '번호' : String(r)] },
        { row: r, col: 1, paras: [r === 0 ? '값' : String(r * 10)] },
      ]).flat(),
    };
    const tables = extractHwpTables(buildHwp(tablePara(t)));
    expect(tables).toHaveLength(1);
    expect(tables[0].cells).toHaveLength(rows);
    expect(tables[0].cells[599]).toEqual(['599', '5990']);
    expect(tables[0].truncated).toBeUndefined();
  });

  it('열 상한을 넘으면 잘라 읽고 원래 크기를 남긴다', () => {
    const cols = MAX_TABLE_COLS + 3;
    const t: HwpTable = {
      rows: 1,
      cols,
      cells: Array.from({ length: cols }, (_, c) => ({ row: 0, col: c, paras: [`h${c}`] })),
    };
    const [table] = extractHwpTables(buildHwp(tablePara(t)));
    expect(table.cells[0]).toHaveLength(MAX_TABLE_COLS);
    expect(table.truncated).toEqual({ cols });
  });

  it('색인 출력은 그대로 — extractTextFromHwp 결과가 바뀌지 않는다', async () => {
    // 리팩터링 전 코드로 뽑아 둔 값. 한 글자라도 바뀌면 이미 색인된 문서와 새 문서의 청크가 어긋난다
    expect(await extractTextFromHwp(sample(), 'a.hwp')).toBe(EXPECTED_INDEX_TEXT);
    // 크기가 비상식적인 표(열 101개)는 색인에서 본문처럼 이어붙인다 — 이 경로도 그대로
    const wide: HwpTable = {
      rows: 2,
      cols: 101,
      cells: Array.from({ length: 3 }, (_, c) => ({ row: 0, col: c, paras: [`w${c}`] })),
    };
    expect(await extractTextFromHwp(buildHwp([...para('앞'), ...tablePara(wide, 0, '표 앞 글')]), 'b.hwp')).toBe(
      '앞\n\n표 앞 글\n\nw0\n\nw1\n\nw2'
    );
  });
});

const EXPECTED_INDEX_TEXT =
  "1. 예산 현황\n\n(단위: 천원)\n\n| 구분 |  | 합계 |\n| --- | --- | --- |\n| 본예산 | 추경 |  |\n| 1,000 (확정) | A\\|B |  |\n| 비고 \\| 안a \\| 안b \\| \\| --- \\| --- \\| | x | y |\n끝 문단";
