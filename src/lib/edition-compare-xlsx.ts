// src/lib/edition-compare-xlsx.ts
// 두 판 신구 대비를 엑셀(신구대비표)로 쓴다. 시트 둘: '신구 대비'(바뀐 문단만)와 '안내'(어느 두 판을 언제 어떻게 맞댔는지).
//
// - 값은 대조 결과(edition-compare.ts)를 그대로 옮긴다. 다시 계산하지 않는다.
// - 바뀐 낱말은 서식 있는 글(richText)로 칠한다 — 옛 판은 빨강 취소선, 새 판은 초록 굵게.
// - 글은 원본 문서에서 온 것이라 수식 주입을 막는다(safeText). 한 칸 32,000자 상한도 safeText가 지킨다.

import type { CellRichTextValue } from 'exceljs';
import { safeText, kstStamp } from '@/lib/xlsx-export';
import { compareSummary, type CompareRow, type EditionComparison, type InlinePart } from '@/lib/edition-compare';
import type { EditionSide } from '@/lib/document-edition-compare';

export interface EditionCompareWorkbookInput {
  old: EditionSide;
  new: EditionSide;
  comparison: EditionComparison;
  warnings: string[];
  createdAt: Date;
}

/** 한 칸의 서식 있는 글 상한 — 넘으면 칠하지 않은 글로 쓴다(safeText가 32,000자에서 자른다) */
const MAX_RICH_CHARS = 30_000;

const KIND_LABEL: Record<'changed' | 'removed' | 'added', string> = { changed: '고침', removed: '삭제', added: '신설' };

const OLD_FONT = { color: { argb: 'FFC00000' }, strike: true };
const NEW_FONT = { color: { argb: 'FF00703C' }, bold: true };

function richOrPlain(parts: InlinePart[], tone: 'old' | 'new'): string | CellRichTextValue {
  const text = parts.map((p) => p.text).join('');
  if (text.length > MAX_RICH_CHARS || !parts.some((p) => p.changed)) return safeText(text);
  // 첫 조각이 =·+·-·@로 시작하면 수식으로 읽히지 않게 앞에 '를 붙인다(글 전체로는 safeText와 같은 규칙)
  const guarded = safeText(text) !== text;
  return {
    richText: parts.map((p, i) => ({
      text: i === 0 && guarded ? `'${p.text}` : p.text,
      ...(p.changed ? { font: tone === 'old' ? OLD_FONT : NEW_FONT } : {}),
    })),
  };
}

type ChangeRow = Extract<CompareRow, { kind: 'changed' | 'removed' | 'added' }>;

/** 엑셀 한 줄 [위치, 구분, 옛 판, 새 판] — 시험이 값을 본다 */
export function changeRowCells(row: ChangeRow): [string, string, string | CellRichTextValue, string | CellRichTextValue] {
  const loc = safeText(row.location ?? '');
  switch (row.kind) {
    case 'changed':
      return [loc, KIND_LABEL.changed, richOrPlain(row.old, 'old'), richOrPlain(row.new, 'new')];
    case 'removed':
      return [loc, KIND_LABEL.removed, safeText(row.old), '(삭제)'];
    case 'added':
      return [loc, KIND_LABEL.added, '(신설)', safeText(row.new)];
  }
}

function sideLines(label: string, s: EditionSide): [string, string][] {
  return [
    [`${label}`, safeText(s.name)],
    [`${label} 시행일`, s.effective_from ?? '적지 않음'],
    [`${label} 상태`, s.status === 'retired' ? '지난 판' : s.status === 'ready' ? '현재 판' : (s.status ?? '알 수 없음')],
  ];
}

/** 내려받는 파일 이름 — 새 판 이름에서 확장자·못 쓰는 글자를 빼고 60자 */
export function compareFileName(newName: string): string {
  const base = newName
    .replace(/\.[A-Za-z0-9]{1,5}$/, '')
    .replace(/[\\/:*?"<>|\p{Cc}\p{Cf}]/gu, '')
    .replace(/\s+/g, ' ')
    .replace(/^[.\s]+|[.\s]+$/g, '')
    .slice(0, 60);
  return `신구대비_${base || '문서'}.xlsx`;
}

export async function buildEditionCompareWorkbook(input: EditionCompareWorkbookInput): Promise<Buffer> {
  // exceljs는 무겁다. 파일을 만들 때만 불러온다.
  const ExcelJS = (await import('exceljs')).default;
  const workbook = new ExcelJS.Workbook();
  workbook.created = input.createdAt;
  workbook.title = `신구 대비 — ${input.new.name}`;

  const sheet = workbook.addWorksheet('신구 대비', { views: [{ state: 'frozen', ySplit: 1 }] });
  sheet.columns = [
    { header: '위치', width: 18 },
    { header: '구분', width: 8 },
    { header: '옛 판 (현행)', width: 60 },
    { header: '새 판 (개정)', width: 60 },
  ];
  sheet.getRow(1).font = { bold: true };
  const changes = input.comparison.rows.filter((r): r is ChangeRow => r.kind !== 'same' && r.kind !== 'skip');
  if (changes.length === 0) {
    sheet.addRow(['', '', '바뀐 문단이 없습니다', '']);
  } else {
    for (const r of changes) sheet.addRow(changeRowCells(r));
  }
  sheet.eachRow((row) => {
    row.alignment = { vertical: 'top', wrapText: true };
  });

  const info = workbook.addWorksheet('안내');
  info.columns = [{ width: 16 }, { width: 90 }];
  const lines: [string, string][] = [
    ...sideLines('옛 판', input.old),
    ...sideLines('새 판', input.new),
    ['만든 때', `${kstStamp(input.createdAt)} (KST)`],
    ['요약', input.comparison.identical ? '두 판의 글이 같습니다' : compareSummary(input.comparison.stats)],
    ['맞댄 방식', '두 원본의 글을 문단 단위로 맞댄 결과입니다(AI를 쓰지 않음). 띄어쓰기만 다른 문단은 같은 문단으로 봅니다.'],
    ['보이지 않는 것', '표 배치·서식·그림의 차이는 보이지 않습니다. 원본으로 확인하세요.'],
    ...input.warnings.map((w): [string, string] => ['경고', safeText(w)]),
  ];
  for (const [k, v] of lines) info.addRow([k, v]);
  info.getColumn(1).font = { bold: true };
  info.eachRow((row) => {
    row.alignment = { vertical: 'top', wrapText: true };
  });

  const out = await workbook.xlsx.writeBuffer();
  return Buffer.from(out as ArrayBuffer);
}
