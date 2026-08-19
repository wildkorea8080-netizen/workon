import { describe, it, expect } from 'vitest';
import { extractTextFromSpreadsheet, isSpreadsheetFile } from '@/lib/spreadsheet';

/**
 * 표 문서 파싱.
 *
 * 핵심은 "열 머리글과 값의 대응이 유지되는가"다. 셀을 순서대로 이어붙이면
 * "A사의 배분 물량?" 같은 질문에 엉뚱한 열을 답하게 된다.
 */

describe('형식 판정', () => {
  it('확장자로 알아본다', () => {
    expect(isSpreadsheetFile('예산.xlsx', '')).toBe(true);
    expect(isSpreadsheetFile('집행.csv', '')).toBe(true);
    expect(isSpreadsheetFile('공문.hwp', '')).toBe(false);
    expect(isSpreadsheetFile('보고서.pdf', '')).toBe(false);
  });

  it('MIME으로도 알아본다', () => {
    // 브라우저가 확장자 없는 이름을 보내는 경우가 있다
    expect(
      isSpreadsheetFile(
        'noext',
        'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
      )
    ).toBe(true);
  });
});

describe('CSV', () => {
  it('머리글과 값의 대응을 유지한다', async () => {
    const csv = '사업명,예산액,집행액\n해외농업개발,1250000,980000\n기술지원,430000,430000\n';
    const out = await extractTextFromSpreadsheet(Buffer.from(csv, 'utf8'), 'a.csv');

    // 마크다운 표라야 열 대응이 산다
    expect(out).toContain('| 사업명 | 예산액 | 집행액 |');
    expect(out).toContain('| 해외농업개발 | 1250000 | 980000 |');
  });

  it('Excel이 붙이는 BOM을 떼어낸다', async () => {
    // 안 떼면 첫 열 머리글이 '﻿사업명'이 되어 검색에 안 걸린다
    const csv = '﻿사업명,예산액\n해외농업개발,1250000\n';
    const out = await extractTextFromSpreadsheet(Buffer.from(csv, 'utf8'), 'a.csv');
    expect(out).toContain('| 사업명 |');
    expect(out).not.toContain('﻿');
  });

  it('셀 안의 파이프를 이스케이프한다', async () => {
    // 안 하면 표 칸이 밀려 전혀 다른 열에 값이 들어간다
    const csv = '항목,비고\n예산,상반기|하반기\n';
    const out = await extractTextFromSpreadsheet(Buffer.from(csv, 'utf8'), 'a.csv');
    expect(out).toContain('상반기\\|하반기');
  });

  it('내용이 없으면 분명히 실패한다', async () => {
    // 조용히 빈 문자열을 돌려주면 문서가 색인은 됐는데 검색이 안 되는 상태가 된다
    await expect(extractTextFromSpreadsheet(Buffer.from('', 'utf8'), 'a.csv')).rejects.toThrow();
  });
});

describe('XLSX', () => {
  /** 테스트용 워크북을 만든다 */
  async function buildWorkbook(build: (wb: any) => void): Promise<Buffer> {
    const ExcelJS = (await import('exceljs')).default;
    const wb = new ExcelJS.Workbook();
    build(wb);
    return Buffer.from(await wb.xlsx.writeBuffer());
  }

  it('수식 셀은 수식이 아니라 계산 결과를 쓴다', async () => {
    const buf = await buildWorkbook((wb) => {
      const ws = wb.addWorksheet('예산');
      ws.addRow(['항목', '금액']);
      ws.addRow(['인건비', 1_250_000]);
      ws.getCell('A3').value = '합계';
      ws.getCell('B3').value = { formula: 'SUM(B2:B2)', result: 1_250_000 };
    });

    const out = await extractTextFromSpreadsheet(buf, 'a.xlsx');
    // =SUM(...)을 색인해 봐야 검색에 안 걸린다. 담당자가 알고 싶은 건 결과 숫자다
    expect(out).toContain('1250000');
    expect(out).not.toContain('SUM(');
  });

  it('날짜를 공문 형식으로 옮긴다', async () => {
    const buf = await buildWorkbook((wb) => {
      const ws = wb.addWorksheet('일정');
      ws.addRow(['항목', '집행일']);
      ws.addRow(['1차', new Date(2026, 7, 19)]);
    });

    const out = await extractTextFromSpreadsheet(buf, 'a.xlsx');
    expect(out).toContain('2026-08-19');
  });

  it('숨긴 시트는 제외한다', async () => {
    const buf = await buildWorkbook((wb) => {
      const ws = wb.addWorksheet('본문');
      ws.addRow(['항목']);
      ws.addRow(['공개내용']);
      const hidden = wb.addWorksheet('계산용');
      hidden.state = 'hidden';
      hidden.addRow(['내부메모']);
    });

    const out = await extractTextFromSpreadsheet(buf, 'a.xlsx');
    expect(out).toContain('공개내용');
    // 계산용 보조 시트는 본문이 아니다
    expect(out).not.toContain('내부메모');
  });

  it('한 시트에 쌓인 표를 나눈다', async () => {
    // 공공기관 엑셀은 시트 하나에 표를 여러 개 세로로 쌓는 일이 흔하다.
    // 이어붙이면 머리글이 표 한가운데 끼어들어 어느 표의 값인지 알 수 없다.
    const buf = await buildWorkbook((wb) => {
      const ws = wb.addWorksheet('물량');
      ws.addRow(['업체명', '배정물량']);
      ws.addRow(['팜스토리', 4130]);
      ws.addRow([]);
      ws.addRow([]);
      ws.addRow(['업체명', '배정물량']);
      ws.addRow(['팜스토리', 492]);
    });

    const out = await extractTextFromSpreadsheet(buf, 'a.xlsx');
    expect(out).toContain('## 물량 (표 1)');
    expect(out).toContain('## 물량 (표 2)');
  });

  it('전부 빈 열은 떼어낸다', async () => {
    // 엑셀은 서식만 넣은 여백 열을 자주 남긴다. 그대로 두면 표가 읽히지 않는다.
    const buf = await buildWorkbook((wb) => {
      const ws = wb.addWorksheet('여백');
      ws.addRow(['', '업체명', '', '배정물량']);
      ws.addRow(['', '팜스토리', '', 4130]);
    });

    const out = await extractTextFromSpreadsheet(buf, 'a.xlsx');
    expect(out).toContain('| 업체명 | 배정물량 |');
  });

  it('자르지 않았으면 잘렸다는 안내를 붙이지 않는다', async () => {
    // 빈 구분 행까지 전체에 세면 아무것도 안 잘렸는데 안내가 붙는다
    const buf = await buildWorkbook((wb) => {
      const ws = wb.addWorksheet('짧음');
      ws.addRow(['항목']);
      ws.addRow(['값']);
      ws.addRow([]);
      ws.addRow([]);
      ws.addRow(['항목']);
      ws.addRow(['값']);
    });

    const out = await extractTextFromSpreadsheet(buf, 'a.xlsx');
    expect(out).not.toContain('행만 포함');
  });

  it('시트 이름을 제목으로 남긴다', async () => {
    const buf = await buildWorkbook((wb) => {
      const ws = wb.addWorksheet('2026년 예산');
      ws.addRow(['항목']);
      ws.addRow(['인건비']);
    });

    const out = await extractTextFromSpreadsheet(buf, 'a.xlsx');
    // 여러 시트가 붙어 나올 때 어느 표인지 알 수 있어야 한다
    expect(out).toContain('## 2026년 예산');
  });
});
