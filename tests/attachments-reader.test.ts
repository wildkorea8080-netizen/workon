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
