import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import ExcelJS from 'exceljs';
import { compareEditions } from '@/lib/edition-compare';
import { buildEditionCompareWorkbook, changeRowCells, compareFileName } from '@/lib/edition-compare-xlsx';
import type { EditionSide } from '@/lib/document-edition-compare';

/** 신구대비표 엑셀(2026-11-05) — 비교 창과 같은 대조 결과를 바뀐 문단만 옮긴다 */

const OLD: EditionSide = { id: 'o', name: '여비 규정(2025)', effective_from: '2025-01-01', status: 'retired', created_at: null };
const NEW: EditionSide = { id: 'n', name: '여비 규정(2026).hwpx', effective_from: '2026-01-01', status: 'ready', created_at: null };

const comparison = compareEditions(
  ['여비 규정', '제2조(일비) 일비는 1일 20,000원으로 한다.', '제3조(숙박비) 숙박비는 실비로 지급한다.', '부칙'].join('\n'),
  ['여비 규정', '제2조(일비) 일비는 1일 25,000원으로 한다.', '제5조(교통비) 교통비는 철도 운임을 기준으로 한다.', '부칙'].join('\n')
);

async function open(buf: Buffer) {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buf as any);
  return wb;
}

function cellText(v: ExcelJS.CellValue): string {
  if (v && typeof v === 'object' && 'richText' in v) return v.richText.map((r) => r.text).join('');
  return String(v ?? '');
}

describe('신구대비표 엑셀', () => {
  it('바뀐 문단만 위치·구분·옛 판·새 판으로 옮긴다', async () => {
    const wb = await open(await buildEditionCompareWorkbook({ old: OLD, new: NEW, comparison, warnings: [], createdAt: new Date('2026-11-05T03:00:00Z') }));
    const sheet = wb.getWorksheet('신구 대비')!;
    expect(sheet.getRow(1).values).toEqual([undefined, '위치', '구분', '옛 판 (현행)', '새 판 (개정)']);
    const rows = [2, 3, 4].map((i) => sheet.getRow(i).values as ExcelJS.CellValue[]);
    expect(rows.map((r) => [r[1], r[2]])).toEqual([
      ['제2조(일비)', '고침'],
      ['제3조(숙박비)', '삭제'],
      ['제5조(교통비)', '신설'],
    ]);
    expect(cellText(rows[0][3])).toBe('제2조(일비) 일비는 1일 20,000원으로 한다.');
    expect(cellText(rows[0][4])).toBe('제2조(일비) 일비는 1일 25,000원으로 한다.');
    expect(rows[1][4]).toBe('(삭제)');
    expect(rows[2][3]).toBe('(신설)');
    // 같은 문단('여비 규정'·'부칙')은 싣지 않는다
    expect(sheet.rowCount).toBe(4);
  });

  it('바뀐 낱말만 칠한다 — 옛 판은 빨강 취소선, 새 판은 초록 굵게', async () => {
    const row = comparison.rows.find((r) => r.kind === 'changed')!;
    const [, , oldCell, newCell] = changeRowCells(row as any);
    expect(typeof oldCell).toBe('object');
    const oldRuns = (oldCell as ExcelJS.CellRichTextValue).richText;
    const newRuns = (newCell as ExcelJS.CellRichTextValue).richText;
    expect(oldRuns.filter((r) => r.font?.strike).map((r) => r.text)).toEqual(['20']);
    expect(newRuns.filter((r) => r.font?.bold).map((r) => r.text)).toEqual(['25']);
    // 파일로 써도 서식이 남는다
    const wb = await open(await buildEditionCompareWorkbook({ old: OLD, new: NEW, comparison, warnings: [], createdAt: new Date() }));
    const v = wb.getWorksheet('신구 대비')!.getCell('D2').value as ExcelJS.CellRichTextValue;
    expect(v.richText.some((r) => r.text === '25' && r.font?.bold)).toBe(true);
  });

  it('안내 시트에 두 판·만든 때(KST)·요약·방식·경고를 적는다', async () => {
    const wb = await open(
      await buildEditionCompareWorkbook({ old: OLD, new: NEW, comparison, warnings: ['옛 판: 글자 인식(OCR)으로 읽었습니다'], createdAt: new Date('2026-11-05T03:00:00Z') })
    );
    const info = wb.getWorksheet('안내')!;
    const pairs = new Map<string, string[]>();
    info.eachRow((r) => {
      const k = String(r.getCell(1).value);
      pairs.set(k, [...(pairs.get(k) ?? []), String(r.getCell(2).value)]);
    });
    expect(pairs.get('옛 판')).toEqual(['여비 규정(2025)']);
    expect(pairs.get('옛 판 상태')).toEqual(['지난 판']);
    expect(pairs.get('새 판 시행일')).toEqual(['2026-01-01']);
    expect(pairs.get('만든 때')).toEqual(['2026-11-05 12:00 (KST)']);
    expect(pairs.get('요약')).toEqual(['고친 문단 1개 · 지운 문단 1개 · 새 문단 1개']);
    expect(pairs.get('경고')).toEqual(['옛 판: 글자 인식(OCR)으로 읽었습니다']);
    expect(pairs.get('맞댄 방식')?.[0]).toContain('AI를 쓰지 않음');
  });

  it('값은 수식이 아니고, 수식처럼 시작하는 글은 글자로 남긴다', async () => {
    const c = compareEditions('=SUM(A1) 옛 글', '=SUM(A1) 새 글');
    const row = c.rows.find((r) => r.kind === 'changed')!;
    const [, , oldCell] = changeRowCells(row as any);
    expect((oldCell as ExcelJS.CellRichTextValue).richText[0].text.startsWith("'=")).toBe(true);
    const removed = changeRowCells({ kind: 'removed', old: '+82 전화', location: null });
    expect(removed[2]).toBe("'+82 전화");
    const wb = await open(await buildEditionCompareWorkbook({ old: OLD, new: NEW, comparison: c, warnings: [], createdAt: new Date() }));
    wb.getWorksheet('신구 대비')!.eachRow((r) => r.eachCell((cell) => expect(cell.type).not.toBe(ExcelJS.ValueType.Formula)));
  });

  it('바뀐 문단이 없으면 그렇게 적는다', async () => {
    const same = compareEditions('가\n나', '가\n나');
    const wb = await open(await buildEditionCompareWorkbook({ old: OLD, new: NEW, comparison: same, warnings: [], createdAt: new Date() }));
    expect(wb.getWorksheet('신구 대비')!.getCell('C2').value).toBe('바뀐 문단이 없습니다');
  });

  it('파일 이름은 새 판 이름에서 확장자·못 쓰는 글자를 뺀다', () => {
    expect(compareFileName('여비 규정(2026).hwpx')).toBe('신구대비_여비 규정(2026).xlsx');
    expect(compareFileName('a/b:c*?"<>|‮.pdf')).toBe('신구대비_abc.xlsx');
    expect(compareFileName('...')).toBe('신구대비_문서.xlsx');
    expect(compareFileName('')).toBe('신구대비_문서.xlsx');
    expect(compareFileName('가'.repeat(100)).length).toBe('신구대비_'.length + 60 + '.xlsx'.length);
  });
});

describe('내려받기', () => {
  const route = readFileSync('src/app/api/documents/[id]/compare/route.ts', 'utf8');
  const ui = readFileSync('src/components/admin/EditionCompareModal.tsx', 'utf8');

  it('같은 권한 확인을 거친 뒤 엑셀을 만든다', () => {
    const at = route.indexOf("get('format') === 'xlsx'");
    expect(at).toBeGreaterThan(route.indexOf('compareDocumentEditions('));
    expect(at).toBeGreaterThan(route.indexOf('if (!outcome.ok)'));
    expect(route).toContain('compareXlsxHeaders(outcome.data.new.name)');
  });

  it('비교 창에 바뀐 곳이 있을 때만 내려받기 단추가 있다', () => {
    expect(ui).toContain('${endpoint}?format=xlsx');
    expect(ui).toContain('!data.comparison.identical &&');
  });
});
