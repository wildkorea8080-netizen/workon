import { describe, it, expect } from 'vitest';
import ExcelJS from 'exceljs';
import JSZip from 'jszip';
import { readCsvTables, readXlsxTables } from '@/lib/attachments/tables-sheet';

/**
 * 엑셀·CSV 계산용 표 읽기. 통합 문서는 테스트 안에서 exceljs로 만든다.
 * 핵심은 "조용히 틀리지 않는가" — 숫자가 글자로, 병합 복사본이 값으로 섞이면 합계가 틀린다.
 */

async function book(build: (wb: ExcelJS.Workbook) => void): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  build(wb);
  return Buffer.from(await wb.xlsx.writeBuffer());
}

describe('엑셀 표 읽기', () => {
  it('숫자 칸은 숫자로, 수식은 결과값으로, 날짜는 YYYY-MM-DD 글로', async () => {
    const bytes = await book((wb) => {
      const ws = wb.addWorksheet('집행');
      ws.addRow(['사업', '예산', '집행', '일자']);
      ws.addRow(['A', 1200, { formula: 'B2*0.5', result: 600 }, new Date(Date.UTC(2026, 2, 5))]);
    });
    const { tables, sheets } = await readXlsxTables(bytes);
    expect(sheets).toEqual(['집행']);
    expect(tables).toHaveLength(1);
    expect(tables[0].id).toBe('t1');
    expect(tables[0].title).toBe('집행');
    expect(tables[0].cells[1][1]).toBe(1200);
    expect(tables[0].cells[1][2]).toBe(600);
    expect(tables[0].cells[1][3]).toBe('2026-03-05');
    expect(tables[0].columns).toEqual(['사업', '예산', '집행', '일자']);
    expect(tables[0].header).toEqual({ from: 0, to: 0 });
  });

  it('세로 병합된 숫자는 주인 칸에만 남는다', async () => {
    const bytes = await book((wb) => {
      const ws = wb.addWorksheet('s');
      ws.addRow(['부서', '합계']);
      ws.addRow(['가', 300]);
      ws.addRow(['나']);
      ws.addRow(['다']);
      ws.mergeCells('B2:B4');
    });
    const { tables } = await readXlsxTables(bytes);
    const t = tables[0];
    expect(t.cells[1][1]).toBe(300);
    expect(t.cells[2][1]).toBeNull();
    expect(t.cells[3][1]).toBeNull();
    expect(t.merges).toEqual([{ row: 1, col: 1, rows: 3, cols: 1 }]);
  });

  it('2단 머리글(가로·세로 병합)을 열 이름으로 잇는다', async () => {
    const bytes = await book((wb) => {
      const ws = wb.addWorksheet('s');
      ws.addRow(['구분', '예산', null]);
      ws.addRow([null, '본예산', '추경']);
      ws.addRow(['총무과', 100, 20]);
      ws.mergeCells('A1:A2');
      ws.mergeCells('B1:C1');
    });
    const { tables } = await readXlsxTables(bytes);
    expect(tables[0].header).toEqual({ from: 0, to: 1 });
    expect(tables[0].columns).toEqual(['구분', '예산 / 본예산', '예산 / 추경']);
  });

  it('숨긴 시트는 빼고 경고한다', async () => {
    const bytes = await book((wb) => {
      wb.addWorksheet('보이는').addRows([['a', 'b'], ['x', 1]]);
      const hidden = wb.addWorksheet('계산용');
      hidden.addRows([['a', 'b'], ['y', 2]]);
      hidden.state = 'hidden';
    });
    const { tables, sheets, warnings } = await readXlsxTables(bytes);
    expect(sheets).toEqual(['보이는']);
    expect(tables).toHaveLength(1);
    expect(warnings).toEqual(['숨긴 시트 제외: 계산용']);
  });

  it('한 시트의 표 두 개를 빈 행 2줄로 나눈다', async () => {
    const bytes = await book((wb) => {
      const ws = wb.addWorksheet('물량');
      ws.addRow(['업체', '톤']);
      ws.addRow(['A', 1]);
      ws.addRow([]);
      ws.addRow([]);
      ws.addRow(['2025년 배정']);
      ws.addRow(['업체', '톤']);
      ws.addRow(['B', 2]);
    });
    const { tables } = await readXlsxTables(bytes);
    expect(tables.map((t) => t.id)).toEqual(['t1', 't2']);
    expect(tables.map((t) => t.title)).toEqual(['물량', '물량 표 2']);
    expect(tables[1].caption).toBe('2025년 배정');
    expect(tables[1].header).toEqual({ from: 1, to: 1 });
    expect(tables[1].cells[2]).toEqual(['B', 2]);
  });

  it('빈 행 1줄은 표 안의 여백이다', async () => {
    const bytes = await book((wb) => {
      wb.addWorksheet('s').addRows([['a', 'b'], ['x', 1], [], ['y', 2]]);
    });
    const { tables } = await readXlsxTables(bytes);
    expect(tables).toHaveLength(1);
    expect(tables[0].cells).toHaveLength(4);
  });

  it('양 끝의 빈 열·행을 다듬는다', async () => {
    const bytes = await book((wb) => {
      const ws = wb.addWorksheet('s');
      ws.addRow([]);
      ws.addRow([null, null, '부서', '예산']);
      ws.addRow([null, null, '가', 5]);
    });
    const { tables } = await readXlsxTables(bytes);
    expect(tables[0].cells).toEqual([['부서', '예산'], ['가', 5]]);
  });

  it('ID는 시트를 넘어 파일 안에서 이어진다', async () => {
    const bytes = await book((wb) => {
      wb.addWorksheet('a').addRows([['x', 'y'], ['p', 1]]);
      wb.addWorksheet('b').addRows([['x', 'y'], ['q', 2]]);
    });
    const { tables } = await readXlsxTables(bytes);
    expect(tables.map((t) => `${t.id}:${t.title}`)).toEqual(['t1:a', 't2:b']);
  });

  it('200열을 넘으면 잘라 읽고 경고한다', async () => {
    const bytes = await book((wb) => {
      const ws = wb.addWorksheet('넓은');
      ws.addRow(Array.from({ length: 250 }, (_, i) => `열${i + 1}`));
      ws.addRow(Array.from({ length: 250 }, (_, i) => i));
    });
    const { tables, warnings } = await readXlsxTables(bytes);
    expect(tables[0].cells[0]).toHaveLength(200);
    expect(tables[0].truncated).toEqual({ cols: 250 });
    expect(warnings).toEqual(['넓은 시트: 열 250개 중 200개만 읽었습니다']);
  });
});

describe('CSV 표 읽기', () => {
  // iconv-lite가 없어 EUC-KR 바이트를 직접 적는다: 구분 금액 총무과
  const EUC_HEAD = [0xb1, 0xb8, 0xba, 0xd0, 0x2c, 0xb1, 0xdd, 0xbe, 0xd7, 0x0a]; // 구분,금액\n
  const EUC_ROW = [0xc3, 0xd1, 0xb9, 0xab, 0xb0, 0xfa, 0x2c, 0x30, 0x30, 0x31, 0x32, 0x0a]; // 총무과,0012\n

  it('EUC-KR을 읽고 칸은 글자로 둔다(앞자리 0 보존)', () => {
    const { tables } = readCsvTables(Buffer.from([...EUC_HEAD, ...EUC_ROW]));
    expect(tables).toHaveLength(1);
    expect(tables[0].cells).toEqual([['구분', '금액'], ['총무과', '0012']]);
    expect(tables[0].columns).toEqual(['구분', '금액']);
    expect(tables[0].title).toBe('표 1');
  });

  it('BOM을 떼고, 빈 줄 2줄로 표를 나눈다', () => {
    const csv = '﻿사업,코드\nA,0012\n\n\n표 제목\n사업,코드\nB,0034\n';
    const { tables } = readCsvTables(Buffer.from(csv, 'utf8'));
    expect(tables.map((t) => t.id)).toEqual(['t1', 't2']);
    expect(tables[0].cells[0][0]).toBe('사업');
    expect(tables[0].cells[1]).toEqual(['A', '0012']);
    expect(tables[1].caption).toBe('표 제목');
    expect(tables[1].cells[2]).toEqual(['B', '0034']);
  });

  it('빈 줄 1줄은 표 안에 둔다', () => {
    const { tables } = readCsvTables(Buffer.from('a,b\nx,1\n\ny,2\n', 'utf8'));
    expect(tables).toHaveLength(1);
    expect(tables[0].cells).toHaveLength(4);
  });

  it('빈 파일은 표가 없다', () => {
    expect(readCsvTables(Buffer.from('', 'utf8')).tables).toEqual([]);
  });
});

describe('1차 수정 — 조용히 틀리는 경우', () => {
  it('CSV: 연도 머리글', () => {
    const { tables } = readCsvTables(Buffer.from('구분,2024,2025\n총무과,100,50\n기획과,50,20\n', 'utf8'));
    expect(tables[0].header).toEqual({ from: 0, to: 0 });
    expect(tables[0].columns).toEqual(['구분', '2024', '2025']);
  });

  it('CSV: 연도 머리글, 데이터 첫 칸들이 글자여도', () => {
    const { tables } = readCsvTables(Buffer.from('구분,2024,2025\n총무과,본청,100\n기획과,본청,50\n', 'utf8'));
    expect(tables[0].header).toEqual({ from: 0, to: 0 });
  });

  it('CSV: 제목 줄 아래 빈 줄 하나 뒤의 연도 머리글', () => {
    const { tables } = readCsvTables(Buffer.from('2026 예산\n\n구분,2024,2025\n총무과,100,200\n', 'utf8'));
    expect(tables).toHaveLength(1);
    expect(tables[0].header).toEqual({ from: 2, to: 2 });
    expect(tables[0].columns).toEqual(['구분', '2024', '2025']);
    expect(tables[0].caption).toBe('2026 예산');
  });

  it('엑셀: 계산 결과가 저장되지 않은 수식은 비우고 경고한다', async () => {
    const bytes = await book((wb) => {
      const ws = wb.addWorksheet('합계');
      ws.addRow(['항목', '값']);
      ws.addRow(['a', 1]);
      ws.addRow(['b', { formula: 'B2+1' } as unknown as ExcelJS.CellValue]);
      ws.addRow(['c', { formula: 'B2+2' } as unknown as ExcelJS.CellValue]);
    });
    const { tables, warnings } = await readXlsxTables(bytes);
    expect(tables[0].cells[2][1]).toBeNull();
    expect(warnings).toContain('합계: 수식 칸 2개는 계산 결과가 저장돼 있지 않아 비워 두었습니다');
  });

  it('엑셀: 250열에 걸친 제목 병합은 잘림 경고를 만들지 않는다', async () => {
    const bytes = await book((wb) => {
      const ws = wb.addWorksheet('s');
      ws.addRow(['2026 예산']);
      ws.mergeCells(1, 1, 1, 250);
      ws.addRow(['부서', '예산', '비고']);
      ws.addRow(['총무과', 1, null]);
    });
    const { tables, warnings } = await readXlsxTables(bytes);
    expect(warnings).toEqual([]);
    expect(tables[0].truncated).toBeUndefined();
    expect(tables[0].cells[0]).toHaveLength(3);
  });

  it('엑셀: 날짜에 시각이 있으면 시각까지, 시각만 있으면 HH:mm', async () => {
    const bytes = await book((wb) => {
      const ws = wb.addWorksheet('s');
      ws.addRow(['일자', '시각', '날짜']);
      ws.addRow([
        new Date(Date.UTC(2026, 2, 5, 14, 30)),
        new Date(Date.UTC(1899, 11, 30, 9, 5)),
        new Date(Date.UTC(2026, 2, 5)),
      ]);
    });
    const { tables } = await readXlsxTables(bytes);
    expect(tables[0].cells[1]).toEqual(['2026-03-05 14:30', '09:05', '2026-03-05']);
  });

  it('엑셀: 20,000행을 넘으면 잘라 읽고 경고한다', async () => {
    const bytes = await book((wb) => {
      const ws = wb.addWorksheet('긴');
      ws.addRow(['번호', '값']);
      for (let i = 1; i <= 20000; i += 1) ws.addRow([i, i * 2]);
    });
    const { tables, warnings } = await readXlsxTables(bytes);
    expect(tables[0].cells).toHaveLength(20000);
    expect(tables[0].truncated).toEqual({ rows: 20001 });
    expect(warnings).toEqual(['긴 시트: 행 20001개 중 20000개만 읽었습니다']);
  }, 60000);

  it('CSV: 20,000행을 넘으면 잘라 읽고 경고한다', () => {
    const lines = ['번호,값'];
    for (let i = 1; i <= 20000; i += 1) lines.push(`${i},${i * 2}`);
    const { tables, warnings } = readCsvTables(Buffer.from(lines.join('\n'), 'utf8'));
    expect(tables[0].cells).toHaveLength(20000);
    expect(tables[0].truncated).toEqual({ rows: 20001 });
    expect(warnings).toEqual(['행 20001개 중 20000개만 읽었습니다']);
  });

  it('CSV: 끝 줄바꿈의 빈 레코드는 행으로 세지 않는다 — 딱 20,000행이면 잘림 경고 없음', () => {
    const lines = ['번호,값'];
    for (let i = 1; i < 20000; i += 1) lines.push(`${i},${i * 2}`);
    for (const tail of ['\n', '\r\n', '\n\n\n', '\n,\n']) {
      const { tables, warnings } = readCsvTables(Buffer.from(lines.join('\n') + tail, 'utf8'));
      expect(warnings, JSON.stringify(tail)).toEqual([]);
      expect(tables[0].cells).toHaveLength(20000);
      expect(tables[0].truncated).toBeUndefined();
    }
  });

  it('CSV: 한 칸짜리 한 줄 블록은 표가 아니라 다음 표의 캡션', () => {
    const csv = '(단위: 천원)\n\n\n부서,예산\n총무과,100\n';
    const { tables } = readCsvTables(Buffer.from(csv, 'utf8'));
    expect(tables).toHaveLength(1);
    expect(tables[0].id).toBe('t1');
    expect(tables[0].caption).toBe('(단위: 천원)');
    expect(tables[0].header).toEqual({ from: 0, to: 0 });
  });

  it('엑셀: 한 칸짜리 블록은 다음 표의 캡션, 이미 캡션이 있으면 잇는다', async () => {
    const bytes = await book((wb) => {
      const ws = wb.addWorksheet('s');
      ws.addRow(['(단위: 천원)']);
      ws.addRow([]);
      ws.addRow([]);
      ws.addRow(['예산 현황']);
      ws.addRow(['부서', '예산']);
      ws.addRow(['총무과', 100]);
    });
    const { tables } = await readXlsxTables(bytes);
    expect(tables).toHaveLength(1);
    expect(tables[0].id).toBe('t1');
    expect(tables[0].caption).toBe('(단위: 천원) 예산 현황');
  });

  it('마지막 블록이 한 칸짜리면 표로 남긴다', () => {
    const { tables } = readCsvTables(Buffer.from('부서,예산\n가,1\n\n\n끝\n', 'utf8'));
    expect(tables).toHaveLength(2);
  });
});

describe('2차 수정', () => {
  it('엑셀: 병합 2,000개·5,000행도 빠르게 읽고 병합 복사본을 비운다', async () => {
    const bytes = await book((wb) => {
      const ws = wb.addWorksheet('큰');
      ws.addRow(['번호', '구분', '값']);
      for (let i = 1; i <= 5000; i += 1) ws.addRow([i, i <= 4000 ? `g${i}` : null, i]);
      for (let i = 0; i < 2000; i += 1) ws.mergeCells(2 + i * 2, 2, 3 + i * 2, 2);
    });
    const t0 = Date.now();
    const { tables } = await readXlsxTables(bytes);
    expect(Date.now() - t0).toBeLessThan(5000);
    const t = tables[0];
    expect(t.merges).toHaveLength(2000);
    expect(t.cells[1][1]).toBe('g1');
    expect(t.cells[2][1]).toBeNull();
    expect(t.cells[3][1]).toBe('g3');
  }, 60000);

  it('엑셀: 넓은 병합(좌표로 풀지 않는 쪽)도 읽기를 막지 않는다', async () => {
    // exceljs로 병합을 만들면 칸 객체를 범위만큼 만들어 느리고 무겁다(열 전체 D1:D1048576은 1GB 넘게).
    // 작은 통합 문서에 병합 기록만 끼워 넣는다. 100,001칸 — WIDE_MERGE_CELLS(100,000)를 넘어 넓은 병합 경로를 탄다
    const plain = await book((wb) => {
      const ws = wb.addWorksheet('s');
      ws.addRows([['a', 'b', 'c'], ['x', 1, 'p'], ['y', 2, 'q']]);
    });
    const zip = await JSZip.loadAsync(plain);
    const sheet = 'xl/worksheets/sheet1.xml';
    const xml = await zip.file(sheet)!.async('string');
    expect(xml).toContain('</sheetData>');
    zip.file(sheet, xml.replace('</sheetData>', '</sheetData><mergeCells count="1"><mergeCell ref="C1:C100001"/></mergeCells>'));
    const bytes = Buffer.from(await zip.generateAsync({ type: 'nodebuffer' }));

    const { tables } = await readXlsxTables(bytes);
    expect(tables[0].cells).toHaveLength(3);
    // 병합 주인이 아닌 칸(C2·C3)은 복사본으로 보고 읽지 않는다 — 넓은 병합 판정이 실제로 돌았다
    expect(tables[0].cells.map((r) => r[2])).toEqual(['c', null, null]);
    expect(tables[0].merges).toEqual([{ row: 0, col: 2, rows: 3, cols: 1 }]);
  });

  it('숫자 하나뿐인 블록은 캡션이 아니라 표로 남는다', () => {
    const { tables } = readCsvTables(Buffer.from('100\n\n\n부서,예산\n총무과,1\n', 'utf8'));
    expect(tables).toHaveLength(2);
    expect(tables[1].caption).toBeUndefined();
  });
});
