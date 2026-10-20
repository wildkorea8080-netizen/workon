/**
 * 표 계산 결과를 엑셀로 쓴다. 시트 둘: '결과'(값)와 '계산 근거'(이 숫자가 어디서 왔는지).
 *
 * - 값은 엔진이 계산한 값만 쓴다. 수식 칸은 없다 — 받은 사람이 열었을 때 다시 계산되며 달라지지 않게.
 * - 글자 칸은 수식으로 읽히지 않게 막는다(수식 주입). 파일 이름·머리글도 원본 파일에서 온 글이라 같다.
 * - 외부 날짜 라이브러리는 쓰지 않는다. 감사 자료는 한국 시간(KST)이라 UTC+9를 직접 더한다.
 */
import type { Workbook } from 'exceljs';
import type { Lineage, ResultColumn } from '@/lib/table-engine/types';

type Cell = string | number | null;

export interface ResultWorkbookInput {
  title: string;
  columns: ResultColumn[];
  rows: Cell[][];
  total: Cell[] | null;
  lineage: Lineage;
  /** describeSpec이 만든 지시 문장 — 호출자가 넘기고 여기서는 그대로 쓴다 */
  specSentences: string[];
  createdAt: Date;
}

const NONE = '없음';
const MIN_WIDTH = 8;
const MAX_WIDTH = 50;
const MAX_CELL_CHARS = 32000;
const MAX_DECIMALS = 4;

/**
 * 엑셀이 수식으로 읽는 첫 글자(= + - @)와, 일부 프로그램이 명령으로 읽는 탭·줄바꿈 앞에 '를 붙인다.
 * 숫자는 건드리지 않는다 — 음수 -5는 글자가 아니라 number로 들어간다.
 */
export function safeText(text: string): string {
  // 홑 줄표('-')는 표에서 '값 없음'을 뜻하는 흔한 표기라 수식이 될 수 없다 — 그대로 둔다
  if (text === '-') return text;
  // 엑셀 한 칸은 32,767자까지다. 넘으면 파일이 열리지 않으므로 여유를 두고 자른다
  const cut = text.length > MAX_CELL_CHARS ? text.slice(0, MAX_CELL_CHARS) + '…' : text;
  return /^[=+\-@\t\r]/.test(cut) ? `'${cut}` : cut;
}

function safeCell(v: Cell): Cell {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null; // NaN·Infinity는 파일에 쓸 수 없다
  if (typeof v === 'string') return safeText(v);
  return null;
}

/** 한글(전각)은 2칸으로 센다 */
function textWidth(s: string): number {
  let w = 0;
  for (const ch of s) w += /[ᄀ-ᇿ㄰-㆏가-힯⺀-鿿＀-￯]/.test(ch) ? 2 : 1;
  return w;
}

function clampWidth(w: number): number {
  return Math.min(MAX_WIDTH, Math.max(MIN_WIDTH, Math.ceil(w)));
}

/** 소수점 아래 자릿수(끝의 0은 뗌, 최대 4) — 4자리 아래는 보여 줘도 의미가 없다 */
function decimalPlaces(v: number): number {
  const frac = v.toFixed(MAX_DECIMALS).split('.')[1] ?? '';
  return frac.replace(/0+$/, '').length;
}

function kstStamp(d: Date): string {
  const k = new Date(d.getTime() + 9 * 3600 * 1000);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${k.getUTCFullYear()}-${p(k.getUTCMonth() + 1)}-${p(k.getUTCDate())} ${p(k.getUTCHours())}:${p(k.getUTCMinutes())}`;
}

function fmtInt(n: number): string {
  return String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

export async function buildResultWorkbook(input: ResultWorkbookInput): Promise<Buffer> {
  // exceljs는 무겁다. 파일을 만들 때만 불러온다.
  const ExcelJS = (await import('exceljs')).default;
  const workbook = new ExcelJS.Workbook();
  workbook.created = input.createdAt;
  workbook.title = input.title; // 문서 속성은 수식으로 읽히지 않는다 — 작은따옴표를 붙이면 제목이 달라진다

  writeResultSheet(workbook, input);
  writeLineageSheet(workbook, input);

  const out = await workbook.xlsx.writeBuffer();
  return Buffer.from(out as ArrayBuffer);
}

function writeResultSheet(workbook: Workbook, input: ResultWorkbookInput) {
  const { columns, rows, total } = input;
  const ws = workbook.addWorksheet('결과', { views: [{ state: 'frozen', ySplit: 1 }] });

  ws.addRow(columns.map((c) => safeText(c.name)));
  ws.getRow(1).font = { bold: true };
  for (const r of rows) ws.addRow(columns.map((_, i) => safeCell(r[i] ?? null)));
  if (total) {
    const row = ws.addRow(columns.map((_, i) => safeCell(total[i] ?? null)));
    row.font = { bold: true };
  }

  const dataRows = total ? [...rows, total] : rows;
  columns.forEach((col, i) => {
    const column = ws.getColumn(i + 1);
    // 소수 자릿수는 열 전체(합계 행 포함)에서 한 번에 정한다 — 한 열에서 3과 12.5가 다른 모양이면 읽기 어렵고,
    // 행 순서에 따라 서식이 달라지면 같은 값이 다르게 보인다
    let maxDec = 0;
    if (col.numeric) {
      for (const r of dataRows) {
        const v = r[i];
        if (typeof v === 'number' && Number.isFinite(v)) maxDec = Math.max(maxDec, decimalPlaces(v));
      }
    }
    let width = textWidth(col.name);
    for (const r of dataRows) {
      const v = r[i];
      if (typeof v === 'number' && Number.isFinite(v)) {
        width = Math.max(width, textWidth(fmtInt(Math.trunc(v))) + (maxDec > 0 ? 1 + maxDec : 0));
      } else if (typeof v === 'string') {
        width = Math.max(width, textWidth(v));
      }
    }
    column.width = clampWidth(width + 2);
    if (col.numeric) column.numFmt = maxDec > 0 ? `#,##0.${'0'.repeat(maxDec)}` : '#,##0';
  });
  // 열 서식은 머리글 칸에도 번지므로 머리글은 글자 서식으로 되돌린다
  ws.getRow(1).eachCell((c) => {
    c.numFmt = '@';
  });
}

function writeLineageSheet(workbook: Workbook, input: ResultWorkbookInput) {
  const { lineage: l } = input;
  const ws = workbook.addWorksheet('계산 근거');
  // 표 모양 줄에서만 열 너비를 정한다 — 문장 줄은 옆 칸이 비어 있어 그대로 이어서 보인다
  const widths: number[] = [];
  const track = (cells: Cell[]) =>
    cells.forEach((v, i) => {
      widths[i] = Math.max(widths[i] ?? 0, textWidth(String(v ?? '')));
    });

  const heading = (text: string, value?: string) => {
    const row = ws.addRow(value === undefined ? [text] : [text, safeText(value)]);
    row.getCell(1).font = { bold: true };
    row.getCell(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFE8EEF7' } };
    track([text]);
    return row;
  };
  const line = (...cells: Cell[]) => {
    const safe = cells.map(safeCell);
    ws.addRow(safe);
    return safe;
  };
  const tableHead = (...names: string[]) => {
    const row = ws.addRow(names);
    row.font = { bold: true };
    track(names);
  };
  const tableRow = (...cells: Cell[]) => track(line(...cells));
  const blank = () => ws.addRow([]);
  const sentences = (title: string, items: string[]) => {
    heading(title);
    if (items.length === 0) line(NONE);
    else for (const s of items) line(s);
    blank();
  };

  const title = ws.addRow([safeText(input.title)]);
  title.font = { bold: true, size: 14 };
  blank();
  heading('만든 때', kstStamp(input.createdAt));
  blank();

  // 보이는 행의 합이 합계와 다른 까닭(잘림 등)이 여기 있다 — 위쪽에 둔다
  sentences('안내', l.notes);

  heading('원천');
  if (l.sources.length === 0) line(NONE);
  else {
    tableHead('파일', '파일 이름', '표', '표 제목', '머리글 행', '읽은 행', '쓴 행');
    for (const s of l.sources) {
      const [a, b] = s.headerRows;
      tableRow(s.file, s.fileName, s.table, s.title, a === b ? `${a}행` : `${a}~${b}행`, s.rowsIn, s.rowsUsed);
    }
  }
  blank();

  heading('행 수');
  line(`쌓은 행 ${fmtInt(l.rowCounts.stacked)} → 거른 뒤 ${fmtInt(l.rowCounts.filtered)} → 결과 ${fmtInt(l.rowCounts.result)}`);
  if (input.rows.length !== l.rowCounts.result) {
    line(`표에 담긴 결과 행 ${fmtInt(input.rows.length)}`);
  }
  blank();

  sentences('지시', input.specSentences);

  heading('이름 맞추기');
  if (l.renamed.length === 0) line(NONE);
  else {
    tableHead('파일', '원래 이름', '새 이름');
    for (const r of l.renamed) tableRow(r.file, r.from, r.to);
  }
  blank();

  heading('단위 맞추기');
  if (l.scaled.length === 0) line(NONE);
  else {
    tableHead('파일', '열', '곱한 수');
    for (const s of l.scaled) tableRow(s.file, s.column, s.factor);
  }
  blank();

  heading('결과 열 단위');
  const unitCols = input.columns.filter((c) => c.numeric);
  if (unitCols.length === 0) line(NONE);
  else {
    tableHead('열', '단위', '단위를 읽은 곳');
    const SRC = { cell: '칸 글', name: '열 이름', caption: '표 위 글' } as const;
    for (const c of unitCols) tableRow(c.name, c.unit ?? '(없음)', c.unitSource ? SRC[c.unitSource] : '(없음)');
  }
  blank();

  heading('뺀 행');
  if (l.skippedRows.length === 0) line(NONE);
  else {
    tableHead('파일', '표', '원본 행', '이유', '글');
    for (const s of l.skippedRows) tableRow(s.file, s.table, s.row, s.reason, s.text);
  }
  blank();

  heading('읽지 못한 칸');
  if (l.unreadable.length === 0) line(NONE);
  else {
    tableHead('파일', '표', '원본 행', '열', '글', '이유');
    for (const u of l.unreadable) tableRow(u.file, u.table, u.row, u.column, u.text, u.reason ?? '숫자로 읽지 못함');
  }
  blank();

  heading('한 번만 센 병합 숫자');
  if (l.mergedNumbers.length === 0) line(NONE);
  else {
    tableHead('파일', '표', '원본 행', '열');
    for (const m of l.mergedNumbers) {
      tableRow(m.file, m.table, m.rowEnd > m.row ? `${m.row}~${m.rowEnd}행` : `${m.row}행`, m.column);
    }
  }
  blank();

  heading('한쪽에만 있는 열');
  if (l.onlyIn.length === 0) line(NONE);
  else {
    tableHead('열', '있는 표');
    for (const o of l.onlyIn) tableRow(o.column, o.files.join(', '));
  }
  blank();

  const warnings = [
    ...l.unitWarnings,
    ...l.parenthesizedNegatives.map((c) => `'${c}' 열의 괄호 숫자는 음수로 읽었습니다 — 부분 금액 표기라면 확인하세요.`),
    ...l.columnWarnings,
    ...l.similarKeys.map((g) => `비슷한 이름이 따로 묶였습니다: ${g.join(', ')}`),
    ...(l.truncated ? ['결과가 길어 표에는 일부 행만 담았습니다 — 위 안내를 확인하세요.'] : []),
  ];
  sentences('경고', warnings);

  widths.forEach((w, i) => {
    ws.getColumn(i + 1).width = Math.min(60, Math.max(MIN_WIDTH, Math.ceil(w) + 2));
  });
}
