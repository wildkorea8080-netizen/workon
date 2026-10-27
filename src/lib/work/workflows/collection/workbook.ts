// src/lib/work/workflows/collection/workbook.ts
import { safeText } from '@/lib/xlsx-export';
import type { CollectionResult } from './aggregate';

/**
 * 취합 결과 → 엑셀(XLSX). 기존 감사용 엑셀(xlsx-export.ts)과 같은 원칙: **값만 쓴다(수식 없음)**, 글자는 수식 주입 방지(safeText).
 * 시트: 결과 · 제출 현황 · 원본 대응 · 확인 사항 · 계산 근거. 잠정 집계면 결과 첫 줄에 그 사실을 적는다.
 * 금액은 정수(#,##0), 비율은 소수 둘째 자리(0.00) 표시 — 저장 값은 계산한 값 그대로(표시만 반올림).
 */
const MAX_CELL = 32000;
const t = (s: string) => safeText(s.length > MAX_CELL ? `${s.slice(0, MAX_CELL)}…` : s);

export async function buildCollectionWorkbook(input: { title: string; period: string | null; result: CollectionResult; createdAt: Date }): Promise<Buffer> {
  const ExcelJS = (await import('exceljs')).default;
  const wb = new ExcelJS.Workbook();
  wb.creator = 'WORKON';
  wb.title = input.title;
  const r = input.result;
  const kst = new Date(input.createdAt.getTime() + 9 * 3600_000).toISOString().replace('T', ' ').slice(0, 16);
  const fmt = (kind: string) => (kind === 'rate' ? '0.00' : '#,##0');

  // 결과
  const ws = wb.addWorksheet('결과', { views: [{ state: 'frozen', ySplit: 3 }] });
  ws.getCell('A1').value = t(input.title + (input.period ? ` (${input.period})` : ''));
  ws.getCell('A1').font = { bold: true, size: 14 };
  ws.getCell('A2').value = t(r.provisional ? '미제출 부서를 제외한 잠정 집계' : '전 부서 제출 기준 집계');
  ws.getCell('A2').font = { bold: true, color: { argb: r.provisional ? 'FFB45309' : 'FF047857' } };
  const header = ['부서', '제출', ...r.fields.map((f) => (f.unit ? `${f.name}(${f.unit})` : f.name))];
  ws.getRow(3).values = header.map(t);
  ws.getRow(3).font = { bold: true };
  let row = 4;
  for (const d of r.departments) {
    const vals = r.fields.map((f) => d.values[f.name] ?? null);
    ws.getRow(row).values = [t(d.name), t(d.status === 'submitted' ? '제출' : '미제출'), ...vals];
    r.fields.forEach((f, i) => (ws.getCell(row, 3 + i).numFmt = fmt(f.kind)));
    row++;
  }
  ws.getRow(row).values = [t(r.provisional ? '합계(잠정)' : '합계'), '', ...r.fields.map((f) => r.totals[f.name] ?? null)];
  ws.getRow(row).font = { bold: true };
  r.fields.forEach((f, i) => (ws.getCell(row, 3 + i).numFmt = fmt(f.kind)));
  ws.columns.forEach((c, i) => (c.width = i === 0 ? 16 : 18));

  // 제출 현황
  const st = wb.addWorksheet('제출 현황');
  st.addRow(['원자료', '부서', '부서 판단', '상태', '중복 원본', '쓴 표', '항목 ↔ 열']).font = { bold: true };
  const by: Record<string, string> = { override: '직원 지정', file_name: '파일 이름', content: '파일 내용' };
  const status: Record<string, string> = { used: '합산', duplicate: '중복 후보(합산 안 함)', excluded: '직원이 뺌', no_department: '부서 모름(합산 안 함)', no_table: '맞는 표 없음' };
  for (const s of r.sources) {
    st.addRow([
      t(s.name),
      t(s.department ?? ''),
      t(s.departmentBy ? by[s.departmentBy] : ''),
      t(status[s.status] ?? s.status),
      t(s.duplicateOf ? r.sources.find((x) => x.id === s.duplicateOf)?.name ?? '' : ''),
      t(s.table ?? ''),
      t(Object.entries(s.columnMap).map(([f, c]) => `${f} ← ${c ?? '없음'}${s.units[f] ? `(${s.units[f]})` : ''}`).join('; ')),
    ]);
  }
  for (const d of r.departments.filter((x) => x.status === 'missing')) st.addRow(['', t(d.name), '', t('미제출'), '', '', '']);
  st.columns.forEach((c) => (c.width = 24));

  // 원본 대응 — 추출 표의 행 번호(시트 셀 주소를 지어내지 않는다)
  const tr = wb.addWorksheet('원본 대응');
  tr.addRow(['부서', '항목', '원자료', '표', '추출 표 행', '원본 값', '원본 단위', `환산 값`]).font = { bold: true };
  for (const x of r.trace) tr.addRow([t(x.department), t(x.field), t(x.sourceName), t(x.table), x.extractedRow, x.rawValue, t(x.unit ?? ''), x.value]);
  tr.addRow([]);
  tr.addRow([t('뺀 행(합계·소계 등)')]).font = { bold: true };
  for (const s of r.skippedRows) tr.addRow(['', '', t(s.sourceName), t(s.table), s.row, t(s.text), t(s.reason), '']);
  if (r.unreadable.length) {
    tr.addRow([t('숫자로 읽지 못한 칸(더하지 않음 — 0 아님)')]).font = { bold: true };
    for (const u of r.unreadable) tr.addRow(['', t(u.column), t(u.sourceName), t(u.table), u.row, t(u.text), '', '']);
  }
  tr.columns.forEach((c) => (c.width = 18));

  // 확인 사항
  const rv = wb.addWorksheet('확인 사항');
  rv.addRow(['중요도', '코드', '내용']).font = { bold: true };
  const sev: Record<string, string> = { blocking: '반드시 고칠 것', warning: '확인 필요', info: '참고' };
  for (const i of r.review) rv.addRow([t(sev[i.severity]), t(i.code), t(i.message)]);
  rv.getColumn(3).width = 100;

  // 계산 근거
  const bs = wb.addWorksheet('계산 근거');
  const lines: [string, string][] = [
    ['만든 때(KST)', kst],
    ['출력 단위(금액)', r.outputUnit],
    ['잠정 집계', r.provisional ? (r.decisions.allowProvisional ? '예(직원 확인함)' : '예(확인 전)') : '아니오'],
    ['계산', '각 원자료 표의 행 값을 항목별로 더한 뒤 부서별·전체로 더함. 합계·소계 행은 뺌. 읽지 못한 칸·빈 칸은 0으로 치지 않음'],
    ...r.fields.filter((f) => f.derived).map((f): [string, string] => [`${f.name} 계산식`, f.derived!]),
    ['직원이 뺀 원자료', r.decisions.excludedSourceIds.map((id) => r.sources.find((s) => s.id === id)?.name ?? id).join(', ') || '없음'],
    ['중복 후보지만 넣은 원자료', r.decisions.includedSourceIds.map((id) => r.sources.find((s) => s.id === id)?.name ?? id).join(', ') || '없음'],
    ['값 종류', '계산된 고정 값(수식 없음) — 받은 사람이 열어도 다시 계산되며 달라지지 않음'],
  ];
  for (const [k, v] of lines) bs.addRow([t(k), t(v)]);
  bs.getColumn(1).width = 26;
  bs.getColumn(2).width = 100;

  return Buffer.from(await wb.xlsx.writeBuffer());
}
