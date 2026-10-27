// src/lib/work/workflows/items/workbook.ts
import { safeText } from '@/lib/xlsx-export';
import { FLAG_LABEL, type ExtractedItem, type ItemsSpec } from './verify';

/**
 * 항목 → 엑셀(XLSX). 값만(수식 없음), 글자는 수식 주입 방지(safeText) — 취합 엑셀과 같은 원칙.
 * 시트: 처리표(항목·확인 필요 표시) · 원문 근거(출처·인용) · 확인 사항.
 */
const MAX_CELL = 32000;
const t = (s: string) => safeText(s.length > MAX_CELL ? `${s.slice(0, MAX_CELL)}…` : s);

export async function buildItemsWorkbook(input: {
  title: string;
  spec: ItemsSpec;
  items: ExtractedItem[];
  /** 항목 id → 추가 열(담당 부서 후보 등) */
  extraColumns?: { label: string; values: Record<string, string> }[];
  review: { severity: string; message: string }[];
  createdAt: Date;
  testMode: boolean;
}): Promise<Buffer> {
  const ExcelJS = (await import('exceljs')).default;
  const wb = new ExcelJS.Workbook();
  wb.creator = 'WORKON';
  wb.title = input.title;
  const kst = new Date(input.createdAt.getTime() + 9 * 3600_000).toISOString().replace('T', ' ').slice(0, 16);
  const extras = input.extraColumns ?? [];

  const ws = wb.addWorksheet(input.spec.name.slice(0, 31).replace(/[\\/?*[\]:]/g, '·'), { views: [{ state: 'frozen', ySplit: 3 }] });
  ws.getCell('A1').value = t(input.title);
  ws.getCell('A1').font = { bold: true, size: 14 };
  ws.getCell('A2').value = t(`만든 때 ${kst} · 원자료에 적힌 값만 옮겼습니다(빈 칸은 확인 필요)${input.testMode ? ' · 시험 모드 결과 — 실제 업무에 쓰지 마세요' : ''}`);
  const header = ['번호', input.spec.typeColumn.label, ...input.spec.columns.map((c) => c.label), ...extras.map((e) => e.label), '확인 필요', '출처'];
  ws.getRow(3).values = header.map(t);
  ws.getRow(3).font = { bold: true };
  input.items.forEach((it, i) => {
    const row = ws.getRow(4 + i);
    const dueText = (c: { key: string; type: string }) => (c.type === 'date' && !it.values[c.key] && it.values[`${c.key}Text`] ? `${it.values[`${c.key}Text`]} (원문)` : it.values[c.key] ?? '');
    row.values = [
      it.id,
      it.type,
      ...input.spec.columns.map((c) => dueText(c)),
      ...extras.map((e) => e.values[it.id] ?? ''),
      it.flags.map((f) => FLAG_LABEL[f]).join(', '),
      it.sourceName ?? '',
    ].map((v) => t(String(v)));
  });
  ws.columns.forEach((col, i) => {
    col.width = i === 0 ? 6 : i === 1 ? 12 : 28;
  });

  const qs = wb.addWorksheet('원문 근거');
  qs.getRow(1).values = ['번호', '출처', '원문 인용', '비운 값'].map(t);
  qs.getRow(1).font = { bold: true };
  input.items.forEach((it, i) => {
    qs.getRow(2 + i).values = [it.id, it.sourceName ?? '', it.quote, it.notes.join(' / ')].map((v) => t(String(v)));
  });
  qs.getColumn(3).width = 80;
  qs.getColumn(4).width = 50;

  const rs = wb.addWorksheet('확인 사항');
  rs.getRow(1).values = ['구분', '내용'].map(t);
  rs.getRow(1).font = { bold: true };
  input.review.forEach((r, i) => {
    rs.getRow(2 + i).values = [r.severity === 'blocking' ? '반드시 고칠 것' : r.severity === 'warning' ? '확인 필요' : '참고', r.message].map(t);
  });
  rs.getColumn(2).width = 100;

  return Buffer.from(await wb.xlsx.writeBuffer());
}
