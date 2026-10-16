import { describe, it, expect, vi } from 'vitest';
import ExcelJS from 'exceljs';
import {
  AttachmentReadError,
  readAttachment,
  summarize,
  tableAsMarkdown,
} from '@/lib/attachments/reader';
import { MAX_EXTRACT_CHARS, READ_TABLE_ROWS } from '@/lib/attachments/limits';
import { buildTable } from '@/lib/attachments/header';
import { buildHwpx, para as xpara, tableAt } from './fixtures/hwpx';
import { buildHwp, para, tablePara } from './fixtures/hwp5';

/**
 * 첨부 읽기 입구. 핵심은 "조용히 틀리지 않는가" — 실패는 항상 사람이 읽는 한국어 이유로,
 * 요약에는 본문이 새지 않고, 표의 병합 복사본이 값으로 섞이지 않는다.
 */

// 스캔 PDF 판정을 위해 pdf-parse만 바꿔 끼운다. 바이트에 'SCAN'이 있으면 글자 층이 없는 문서
vi.mock('pdf-parse/lib/pdf-parse.js', () => ({
  default: async (b: Buffer) =>
    b.toString().includes('SCAN')
      ? { text: '\n\n \n', numpages: 3 }
      : { text: '본문 한 줄\n'.repeat(30), numpages: 1 },
}));

async function xlsx(build: (wb: ExcelJS.Workbook) => void): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  build(wb);
  return Buffer.from(await wb.xlsx.writeBuffer());
}

async function failure(p: Promise<unknown>): Promise<AttachmentReadError> {
  try {
    await p;
  } catch (e) {
    expect(e).toBeInstanceOf(AttachmentReadError);
    return e as AttachmentReadError;
  }
  throw new Error('실패해야 한다');
}

describe('readAttachment', () => {
  it('엑셀: 표와 본문, 요약에 열 이름·행 수', async () => {
    const bytes = await xlsx((wb) => {
      const ws = wb.addWorksheet('Sheet1');
      ws.addRow(['부서', '예산']);
      ws.addRow(['총무과', 100]);
      ws.addRow(['기획과', 200]);
    });
    const ex = await readAttachment(bytes, '예산.xlsx');
    expect(ex.kind).toBe('spreadsheet');
    expect(ex.sheets).toEqual(['Sheet1']);
    expect(ex.tables).toHaveLength(1);
    expect(ex.text).toContain('## Sheet1');
    expect(ex.text).toContain('| 총무과 | 100 |');
    expect(summarize(ex).tables[0]).toEqual({ id: 't1', title: 'Sheet1', rows: 2, columns: ['부서', '예산'] });
  });

  it('요약에는 본문이 없다', async () => {
    const unique = '이문장은요약에절대나오면안된다';
    const ex = await readAttachment(Buffer.from(`${unique}\n둘째 줄`), '메모.txt');
    const s = summarize(ex);
    expect(JSON.stringify(s)).not.toContain(unique);
    expect(s.chars).toBe(ex.text.length);
    expect(s.kind).toBe('text');
  });

  it('XLS·PPT·DOC는 저장 형식을 바꾸라는 안내로 실패', async () => {
    for (const [name, hint] of [
      ['a.xls', 'XLSX'],
      ['a.ppt', 'PPTX'],
      ['a.doc', 'DOCX'],
    ]) {
      const e = await failure(readAttachment(Buffer.from('x'), name));
      expect(e.message).toContain(hint);
    }
  });

  it('깨진 zip(.xlsx 확장자의 아무 바이트)은 한국어 실패', async () => {
    const e = await failure(readAttachment(Buffer.from('zip 아님'), 'a.xlsx'));
    expect(e.message).toContain('손상');
    // 원인은 서버 로그용으로 남긴다
    expect((e as { cause?: unknown }).cause).toBeDefined();
  });

  it('허용 밖 확장자도 AttachmentReadError', async () => {
    await failure(readAttachment(Buffer.from('x'), 'a.exe'));
  });

  it('글자 층 없는 PDF는 스캔 안내로 실패', async () => {
    const e = await failure(readAttachment(Buffer.from('%PDF SCAN'), 'a.pdf'));
    expect(e.message).toBe('스캔 문서(글자 층이 없는 PDF)는 아직 읽지 못합니다.');
  });

  it('글자 층 있는 PDF는 본문과 쪽수', async () => {
    const ex = await readAttachment(Buffer.from('%PDF ok'), 'a.pdf');
    expect(ex.kind).toBe('document');
    expect(ex.pages).toBe(1);
    expect(ex.tables).toEqual([]);
    expect(ex.text).toContain('본문 한 줄');
  });

  it('본문 상한을 넘으면 자르고 경고', async () => {
    const ex = await readAttachment(Buffer.from('가'.repeat(MAX_EXTRACT_CHARS + 500)), 'big.txt');
    expect(ex.text.length).toBe(MAX_EXTRACT_CHARS);
    expect(ex.warnings.join('\n')).toContain(MAX_EXTRACT_CHARS.toLocaleString('ko-KR'));
  });

  it('TXT: UTF-8이 깨지면 EUC-KR로 읽는다', async () => {
    // '예산 현황' 의 EUC-KR 바이트 (UTF-8로는 유효하지 않다)
    const euckr = Buffer.from([0xbf, 0xb9, 0xbb, 0xea, 0x20, 0xc7, 0xf6, 0xc8, 0xb2]);
    const ex = await readAttachment(euckr, 'a.txt');
    expect(ex.text).toContain('예산 현황');
  });

  it('본문도 표도 없으면 읽을 글이 없다고 실패', async () => {
    const e = await failure(readAttachment(Buffer.from('  \n \n'), 'a.txt'));
    expect(e.message).toBe('파일에서 읽을 글이 없습니다.');
  });

  it('CSV도 스프레드시트로 표가 나온다', async () => {
    const ex = await readAttachment(Buffer.from('부서,예산\n총무과,100\n'), 'a.csv');
    expect(ex.kind).toBe('spreadsheet');
    expect(ex.tables[0].columns).toEqual(['부서', '예산']);
  });

  it('HWPX: 본문과 표를 함께 읽는다', async () => {
    const bytes = await buildHwpx(xpara('1. 현황') + tableAt([['구분', '금액'], ['가', '10']]));
    const ex = await readAttachment(bytes, 'a.hwpx');
    expect(ex.kind).toBe('document');
    expect(ex.text).toContain('현황');
    expect(ex.tables).toHaveLength(1);
    expect(ex.tables[0].title).toBe('표 1');
  });

  it('HWP 5.0: 표를 칸 배열로', async () => {
    const bytes = buildHwp([
      ...para('개요'),
      ...tablePara({
        rows: 2,
        cols: 2,
        cells: [
          { row: 0, col: 0, paras: ['구분'] },
          { row: 0, col: 1, paras: ['금액'] },
          { row: 1, col: 0, paras: ['가'] },
          { row: 1, col: 1, paras: ['10'] },
        ],
      }),
    ]);
    const ex = await readAttachment(bytes, 'a.hwp');
    expect(ex.kind).toBe('document');
    expect(ex.tables).toHaveLength(1);
    expect(ex.tables[0].cells[1]).toEqual(['가', '10']);
  });
});

describe('tableAsMarkdown', () => {
  const rows = Array.from({ length: 450 }, (_, i) => [`항목${i + 1}`, i + 1]);
  const table = buildTable(1, '표', [['항목', '값'], ...rows], []);

  it('200행 쪽 나눔과 이어 읽기 안내', () => {
    expect(READ_TABLE_ROWS).toBe(200);
    const first = tableAsMarkdown(table);
    expect(first).toContain('| 항목 | 값 |');
    expect(first).toContain('| 항목200 | 200 |');
    expect(first).not.toContain('항목201 ');
    expect(first).toContain('… 이하 250행 더 있음 (offset=200로 이어 읽기)');

    const next = tableAsMarkdown(table, { offset: 200 });
    expect(next).toContain('| 항목201 | 201 |');
    expect(next).toContain('… 이하 50행 더 있음 (offset=400로 이어 읽기)');

    const last = tableAsMarkdown(table, { offset: 400 });
    expect(last).toContain('| 항목450 | 450 |');
    expect(last).not.toContain('이어 읽기');
  });

  it('칸 안의 | 와 줄바꿈은 표를 깨지 않게 다듬는다', () => {
    const t = buildTable(1, '표', [['a', 'b'], ['x|y', 'p\nq']], []);
    expect(tableAsMarkdown(t)).toContain('| x\\|y | p q |');
  });
});

describe('병합 복사본', () => {
  it('세로 병합된 숫자가 여러 행에 복사돼 보이지 않는다', async () => {
    const bytes = await xlsx((wb) => {
      const ws = wb.addWorksheet('s');
      ws.addRow(['부서', '합계']);
      ws.addRow(['가', 300]);
      ws.addRow(['나']);
      ws.addRow(['다']);
      ws.mergeCells('B2:B4');
    });
    const ex = await readAttachment(bytes, 'm.xlsx');
    // 300은 한 번만 — 복사본이 보이면 합계가 세 배가 된다
    expect(ex.text.match(/300/g)).toHaveLength(1);
    expect(ex.tables[0].cells[2][1]).toBeNull();
  });
});

describe('단위·잘림이 모델에게 보인다 (최종 수정)', () => {
  it('표 위 글(단위)을 표 앞에 적는다 — 본문에도 남는다', async () => {
    const t = buildTable(1, 'Sheet1', [['부서', '예산'], ['총무과', 100]], [], '(단위: 천원)');
    const md = tableAsMarkdown(t);
    expect(md.split('\n')[0]).toBe('표 위 글: (단위: 천원)');
    expect(md).toContain('| 부서 | 예산 |');

    const bytes = await xlsx((wb) => {
      const ws = wb.addWorksheet('Sheet1');
      ws.addRow(['(단위: 천원)']);
      ws.addRow(['부서', '예산']);
      ws.addRow(['총무과', 100]);
    });
    const ex = await readAttachment(bytes, '예산.xlsx');
    expect(ex.text).toContain('표 위 글: (단위: 천원)');
  });

  it('잘린 표는 원래 크기를 표 앞에 적는다', () => {
    const t = buildTable(1, '표 1', [['부서', '예산'], ['총무과', 100]], [], undefined, { rows: 25_000 });
    expect(tableAsMarkdown(t)).toContain('잘림: 원래 25,000행 · 2열 중 일부만 읽음');
    const wide = buildTable(1, '표 1', [['부서', '예산'], ['총무과', 100]], [], undefined, { rows: 30_000, cols: 250 });
    expect(tableAsMarkdown(wide, { offset: 0 })).toContain('잘림: 원래 30,000행 · 250열 중 일부만 읽음');
  });

  it('요약 표에 caption·잘림을 싣는다(없으면 키 없음)', () => {
    const t = buildTable(1, '표 1', [['부서', '예산'], ['총무과', 100]], [], '(단위: 원)', { rows: 25_000 });
    const plain = buildTable(2, '표 2', [['부서', '예산'], ['총무과', 100]], []);
    const s = summarize({ kind: 'document', text: 'x', tables: [t, plain], warnings: [] });
    expect(s.tables[0]).toMatchObject({ caption: '(단위: 원)', truncated: true });
    expect(s.tables[1]).toEqual({ id: 't2', title: '표 2', rows: 1, columns: ['부서', '예산'] });
  });
});

describe('표 보기 — 세로 병합 글자 칸 (최종 수정)', () => {
  it('세로 병합된 글자 칸은 보기에서만 아래로 채운다 — 숫자는 주인 칸에만', () => {
    const cells = [['부서', '항목', '금액'], ['총무과', '인건비', 300], [null, '운영비', null], ['기획과', '인건비', 10]];
    const merges = [{ row: 1, col: 0, rows: 2, cols: 1 }, { row: 1, col: 2, rows: 2, cols: 1 }];
    const t = buildTable(1, '표 1', cells, merges);
    const md = tableAsMarkdown(t);
    expect(md).toContain('| 총무과 | 운영비 |  |');
    expect(md.match(/300/g)).toHaveLength(1);
    // 저장된 칸은 그대로
    expect(t.cells[2][0]).toBeNull();
    // 이어 읽기로 주인 행이 앞쪽 쪽에 있어도 채운다
    expect(tableAsMarkdown(t, { offset: 1 })).toContain('| 총무과 | 운영비 |');
  });

  it('머리글에서 내려온 세로 병합은 데이터 칸에 채우지 않는다', () => {
    const cells = [['구분', '값'], [null, 'a'], [null, 'b']];
    const t = buildTable(1, '표 1', cells, [{ row: 0, col: 0, rows: 3, cols: 1 }]);
    expect(tableAsMarkdown(t)).not.toContain('| 구분 | a |');
  });
});

describe('형식·크기 보정 (최종 수정)', () => {
  it('이름이 .hwp여도 내용이 HWPX(zip)면 HWPX 표로 읽는다', async () => {
    const bytes = await buildHwpx(xpara('개요') + tableAt([['구분', '금액'], ['가', '10']]));
    const ex = await readAttachment(bytes, '이름만바뀐.hwp');
    expect(ex.tables).toHaveLength(1);
    expect(ex.tables[0].cells[1]).toEqual(['가', '10']);
  });

  it('표가 100개를 넘으면 앞의 100개만 읽고 알린다', async () => {
    const blocks = Array.from({ length: 150 }, (_, i) => `부서${i},예산\n총무과,${i}`);
    const ex = await readAttachment(Buffer.from(blocks.join('\n\n\n')), 'many.csv');
    expect(ex.tables).toHaveLength(100);
    expect(ex.warnings).toContain('표가 많아 앞의 100개만 읽었습니다 (전체 150개)');
    expect(ex.text).not.toContain('부서100,');
    expect(ex.text).not.toContain('| 부서100 |');
  });

  it('큰 표의 본문은 상한에서 멈춘다 — 다 만든 뒤 자르지 않는다', async () => {
    const lines = ['이름,내용,금액'];
    for (let i = 0; i < 19_000; i += 1) lines.push(`항목${i},${'가'.repeat(60)},${i}`);
    const ex = await readAttachment(Buffer.from(lines.join('\n')), 'big.csv');
    expect(ex.text.length).toBeLessThanOrEqual(MAX_EXTRACT_CHARS);
    expect(ex.text).not.toContain('이어 읽기');
    expect(ex.warnings.join('\n')).toContain(`앞의 ${MAX_EXTRACT_CHARS.toLocaleString('ko-KR')}자만 읽었습니다`);
    // 본문을 다 만든 뒤 잘랐다면 전체 길이('본문이 1,400,000자라')를 알 수 있다 — 멈췄으면 모른다
    expect(ex.warnings.join('\n')).not.toMatch(/본문이 [\d,]+자라/);
    // 표 자체는 전부 남는다(계산용)
    expect(ex.tables[0].cells).toHaveLength(19_001);
  });

  it('여러 표의 본문도 상한을 넘으면 뒤 표는 본문에 붙이지 않는다', async () => {
    const block = (k: number) => [`이름${k},내용`, ...Array.from({ length: 2000 }, (_, i) => `항목${i},${'나'.repeat(50)}`)].join('\n');
    const ex = await readAttachment(Buffer.from([block(1), block(2), block(3)].join('\n\n\n')), 'three.csv');
    expect(ex.tables).toHaveLength(3);
    expect(ex.text).toContain('## 표 1');
    expect(ex.text).not.toContain('## 표 3');
    expect(ex.text.length).toBeLessThanOrEqual(MAX_EXTRACT_CHARS);
    expect(ex.warnings.join('\n')).not.toMatch(/본문이 [\d,]+자라/);
  });
});
