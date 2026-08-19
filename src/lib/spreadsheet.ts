import Papa from 'papaparse';

/**
 * 표 문서(XLSX / CSV) 텍스트 추출.
 *
 * 공공기관 업무의 상당량이 표다 — 예산서, 집행내역, 사업 목록, 통계표.
 * 지금까지 이 형식을 아예 못 올렸다.
 *
 * **셀을 순서대로 이어붙이지 않고 마크다운 표로 복원한다.** 이어붙이면
 * 열 머리글과 값의 대응이 끊겨 "A사의 배분 물량?" 같은 질문에 엉뚱한 열을
 * 답하게 된다. HWP 표(`hwp.ts`)와 스캔 판독(`pdf-ocr.ts`)에서 이미 같은
 * 결론에 도달했고, 여기서도 같은 형태로 맞춘다.
 */

/** 시트 하나에서 가져올 최대 행. 넘으면 잘라내고 그 사실을 남긴다. */
const MAX_ROWS_PER_SHEET = 500;
/** 열이 지나치게 많으면 표가 읽히지 않는다. */
const MAX_COLS = 40;

const SPREADSHEET_EXTENSIONS = ['.xlsx', '.xlsm', '.csv'];

export function isSpreadsheetFile(fileName: string, mimeType: string): boolean {
  const lower = fileName.toLowerCase();
  if (SPREADSHEET_EXTENSIONS.some((ext) => lower.endsWith(ext))) return true;
  return (
    mimeType === 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' ||
    mimeType === 'application/vnd.ms-excel' ||
    mimeType === 'text/csv'
  );
}

/** 마크다운 표에서 파이프는 열 구분자라 그대로 두면 칸이 밀린다. */
function escapeCell(value: string): string {
  return value.replace(/\|/g, '\\|').replace(/\r?\n/g, ' ').trim();
}

/**
 * 셀 값을 문자열로. exceljs는 타입에 따라 객체를 준다.
 *
 * 수식 셀은 수식이 아니라 **계산 결과**를 쓴다. `=SUM(B2:B10)`을 색인해 봐야
 * 검색에 걸리지 않고, 담당자가 알고 싶은 것은 결과 숫자다.
 */
function cellToText(value: unknown): string {
  if (value == null) return '';

  if (value instanceof Date) {
    // 공문에서 쓰는 형식으로. 시각까지 필요한 경우는 드물다.
    const y = value.getFullYear();
    const m = String(value.getMonth() + 1).padStart(2, '0');
    const d = String(value.getDate()).padStart(2, '0');
    return `${y}-${m}-${d}`;
  }

  if (typeof value === 'object') {
    const obj = value as Record<string, unknown>;
    // 수식 셀 { formula, result }
    if ('result' in obj) return cellToText(obj.result);
    // 리치 텍스트 { richText: [{ text }] }
    if (Array.isArray(obj.richText)) {
      return obj.richText.map((part: { text?: string }) => part.text ?? '').join('');
    }
    // 하이퍼링크 { text, hyperlink }
    if ('text' in obj) return cellToText(obj.text);
    if ('error' in obj) return String(obj.error);
    return '';
  }

  return String(value);
}

/** 행 배열을 마크다운 표로. 첫 행을 머리글로 본다. */
function toMarkdownTable(rows: string[][]): string {
  if (rows.length === 0) return '';

  const width = Math.min(MAX_COLS, Math.max(...rows.map((r) => r.length)));
  const pad = (row: string[]) =>
    Array.from({ length: width }, (_, i) => escapeCell(row[i] ?? ''));

  const [head, ...body] = rows;
  const lines = [
    `| ${pad(head).join(' | ')} |`,
    `| ${Array(width).fill('---').join(' | ')} |`,
    ...body.map((row) => `| ${pad(row).join(' | ')} |`),
  ];
  return lines.join('\n');
}

const isEmptyRow = (row: string[]) => row.every((cell) => !cell.trim());

/** 앞뒤의 완전히 빈 행을 떼어낸다. 서식만 있는 빈 행이 흔하다. */
function trimEmptyRows(rows: string[][]): string[][] {
  let start = 0;
  let end = rows.length;
  while (start < end && isEmptyRow(rows[start])) start += 1;
  while (end > start && isEmptyRow(rows[end - 1])) end -= 1;
  return rows.slice(start, end);
}

/**
 * 한 시트에 쌓여 있는 표들을 나눈다.
 *
 * 공공기관 엑셀은 시트 하나에 표를 여러 개 세로로 쌓는 일이 흔하다
 * (품목별·연도별 등). 그대로 이어붙이면 머리글 행이 표 한가운데 끼어들어
 * 어느 표의 값인지 알 수 없게 된다. 실제로 업체별 배정물량 표 두 개가
 * 하나로 합쳐져 같은 업체가 두 번 나오는 상태가 됐다.
 *
 * 빈 행이 2줄 이상 이어지면 다른 표로 본다. 1줄은 표 안의 여백일 때가 많다.
 */
function splitTableBlocks(rows: string[][]): string[][][] {
  const blocks: string[][][] = [];
  let current: string[][] = [];
  let blankRun = 0;

  for (const row of rows) {
    if (isEmptyRow(row)) {
      blankRun += 1;
      // 경계를 넘어선 순간 한 번만 끊는다
      if (blankRun === 2 && current.length > 0) {
        blocks.push(current);
        current = [];
      }
      continue;
    }
    blankRun = 0;
    current.push(row);
  }

  if (current.length > 0) blocks.push(current);
  return blocks.filter((b) => b.length > 0);
}

/**
 * 전부 비어 있는 열을 떼어낸다.
 *
 * 엑셀은 서식만 넣은 열이나 표 왼쪽 여백 열을 자주 남긴다. 그대로 두면
 * 마크다운 표에 빈 칸만 있는 열이 생겨 읽기 어렵고 임베딩에도 잡음이 된다.
 */
function dropEmptyColumns(rows: string[][]): string[][] {
  const width = Math.max(0, ...rows.map((r) => r.length));
  const keep: number[] = [];
  for (let c = 0; c < width; c += 1) {
    if (rows.some((row) => (row[c] ?? '').trim())) keep.push(c);
  }
  if (keep.length === 0) return rows;
  return rows.map((row) => keep.map((c) => row[c] ?? ''));
}

function renderSheet(name: string, rows: string[][]): string {
  const trimmed = trimEmptyRows(rows);
  if (trimmed.length === 0) return '';

  const blocks = splitTableBlocks(trimmed);
  const sections: string[] = [];
  let used = 0;

  blocks.forEach((block, index) => {
    if (used >= MAX_ROWS_PER_SHEET) return;

    const cleaned = dropEmptyColumns(block);
    const room = MAX_ROWS_PER_SHEET - used;
    const shown = cleaned.length > room ? cleaned.slice(0, room) : cleaned;
    used += shown.length;

    // 표가 여럿이면 번호를 붙인다. 어느 표의 값인지 물었을 때 구분이 된다.
    const heading = blocks.length > 1 ? `## ${name} (표 ${index + 1})` : `## ${name}`;
    sections.push(`${heading}\n\n${toMarkdownTable(shown)}`);
  });

  if (sections.length === 0) return '';

  // 빈 구분 행은 세지 않는다. 그걸 포함해 비교하면 아무것도 자르지 않았는데
  // "일부만 포함했다"는 안내가 붙는다.
  const total = blocks.reduce((sum, block) => sum + block.length, 0);
  const note =
    used < total ? `\n\n[행이 많아 앞 ${used}행만 포함했습니다. 전체 ${total}행]` : '';

  return sections.join('\n\n') + note;
}

async function extractFromXlsx(fileBuffer: Buffer): Promise<string> {
  // exceljs는 무겁다. 표 문서를 올릴 때만 불러온다.
  const ExcelJS = (await import('exceljs')).default;
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(fileBuffer as unknown as ArrayBuffer);

  const sections: string[] = [];

  workbook.eachSheet((worksheet) => {
    // 숨긴 시트는 대개 계산용 보조 자료라 본문이 아니다.
    if (worksheet.state === 'hidden' || worksheet.state === 'veryHidden') return;

    const rows: string[][] = [];
    worksheet.eachRow({ includeEmpty: true }, (row) => {
      const cells: string[] = [];
      // row.values는 1-based이고 [0]은 비어 있다
      const values = Array.isArray(row.values) ? row.values.slice(1) : [];
      for (let i = 0; i < Math.min(values.length, MAX_COLS); i += 1) {
        cells.push(cellToText(values[i]));
      }
      rows.push(cells);
    });

    const section = renderSheet(worksheet.name, rows);
    if (section) sections.push(section);
  });

  if (sections.length === 0) {
    throw new Error('표에서 내용을 찾지 못했습니다. 빈 파일인지 확인해주세요.');
  }

  return sections.join('\n\n');
}

function extractFromCsv(fileBuffer: Buffer): string {
  // 공공기관 CSV는 EUC-KR인 경우가 많다. UTF-8로 읽어 깨지면 다시 시도한다.
  let text = new TextDecoder('utf-8').decode(fileBuffer);
  if (text.includes('�')) {
    try {
      text = new TextDecoder('euc-kr').decode(fileBuffer);
    } catch {
      // euc-kr 디코더가 없는 런타임이면 원래 결과를 쓴다
    }
  }
  // Excel이 붙이는 BOM을 떼지 않으면 첫 열 머리글에 섞인다
  text = text.replace(/^﻿/, '');

  const parsed = Papa.parse<string[]>(text, { skipEmptyLines: 'greedy' });
  const rows = (parsed.data ?? []).filter(Array.isArray);

  if (rows.length === 0) {
    throw new Error('CSV에서 내용을 찾지 못했습니다.');
  }

  return renderSheet('표', rows.map((row) => row.map((cell) => String(cell ?? ''))));
}

export async function extractTextFromSpreadsheet(
  fileBuffer: Buffer,
  fileName: string
): Promise<string> {
  const lower = fileName.toLowerCase();
  if (lower.endsWith('.csv')) return extractFromCsv(fileBuffer);
  return extractFromXlsx(fileBuffer);
}
