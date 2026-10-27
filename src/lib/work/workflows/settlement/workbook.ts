// src/lib/work/workflows/settlement/workbook.ts
import { safeText } from '@/lib/xlsx-export';
import { TX_FLAG_LABEL, type SettlementResult } from './reconcile';

/**
 * 대사 결과 → 엑셀. 값만(수식 없음), 글자는 수식 주입 방지 — 취합·처리표와 같은 원칙.
 * 시트: 대사표(거래별) · 예산 잔액 · 증빙 목록 · 확인 사항 · 계산 근거
 */
const MAX_CELL = 32000;
const t = (s: string) => safeText(s.length > MAX_CELL ? `${s.slice(0, MAX_CELL)}…` : s);
const EV_LABEL: Record<string, string> = { unmatched: '대응 거래 없음', duplicate_receipt: '중복 증빙', ocr_amount: 'OCR 금액', amount_unread: '금액 못 읽음' };

export async function buildSettlementWorkbook(input: { title: string; period: string; result: SettlementResult; createdAt: Date }): Promise<Buffer> {
  const ExcelJS = (await import('exceljs')).default;
  const wb = new ExcelJS.Workbook();
  wb.creator = 'WORKON';
  wb.title = input.title;
  const r = input.result;
  const kst = new Date(input.createdAt.getTime() + 9 * 3600_000).toISOString().replace('T', ' ').slice(0, 16);
  const money = '#,##0';

  const ws = wb.addWorksheet('대사표', { views: [{ state: 'frozen', ySplit: 3 }] });
  ws.getCell('A1').value = t(`${input.title} (${input.period})`);
  ws.getCell('A1').font = { bold: true, size: 14 };
  ws.getCell('A2').value = t(`만든 때 ${kst} · 대사 결과입니다(비용 인정·지급·전표 입력 아님) · 집행 ${r.totals.executed.toLocaleString('ko-KR')}원 중 증빙 대응 ${r.totals.evidenced.toLocaleString('ko-KR')}원`);
  ws.getRow(3).values = ['번호', '일자', '과목', '적요', '거래처', '금액(원)', '증빙번호', '대응 증빙', '확인', '출처'].map(t);
  ws.getRow(3).font = { bold: true };
  r.transactions.forEach((x, i) => {
    const row = ws.getRow(4 + i);
    row.values = [t(x.id), t(x.date ?? ''), t(x.item), t(x.desc), t(x.vendor), x.amount, t(x.evidenceNo), t(x.evidenceId ?? ''), t(x.flags.map((f) => TX_FLAG_LABEL[f]).join(', ')), t(`${x.source} ${x.row}행`)];
    row.getCell(6).numFmt = money;
  });
  ws.columns.forEach((c, i) => (c.width = [6, 12, 14, 28, 18, 14, 14, 10, 28, 24][i] ?? 14));

  const bs = wb.addWorksheet('예산 잔액');
  bs.getRow(1).values = ['과목', '예산(원)', '순집행(원)', '잔액(원)'].map(t);
  bs.getRow(1).font = { bold: true };
  r.budget.forEach((b, i) => {
    const row = bs.getRow(2 + i);
    row.values = [t(b.item), b.budget ?? t('예산표에 없음'), b.executed, b.balance ?? t('—')];
    [2, 3, 4].forEach((c) => (row.getCell(c).numFmt = money));
  });
  const tr = bs.getRow(2 + r.budget.length);
  tr.values = [t('합계'), r.totals.budget ?? t('—'), r.totals.executed, r.totals.balance ?? t('—')];
  tr.font = { bold: true };
  [2, 3, 4].forEach((c) => (tr.getCell(c).numFmt = money));
  bs.columns.forEach((c) => (c.width = 18));

  const es = wb.addWorksheet('증빙 목록');
  es.getRow(1).values = ['번호', '일자', '상호', '금액(원)', '증빙번호', '대응 거래', '확인', '출처'].map(t);
  es.getRow(1).font = { bold: true };
  r.evidence.forEach((e, i) => {
    const row = es.getRow(2 + i);
    row.values = [t(e.id), t(e.date ?? ''), t(e.vendor), e.amount ?? t('못 읽음'), t(e.evidenceNo), t(e.transactionIds.join(', ')), t(e.flags.map((f) => EV_LABEL[f] ?? f).join(', ')), t(`${e.source}${e.row ? ` ${e.row}행` : ''}${e.ocr ? ' (OCR)' : ''}`)];
    row.getCell(4).numFmt = money;
  });
  es.columns.forEach((c, i) => (c.width = [6, 12, 18, 14, 14, 14, 24, 30][i] ?? 14));

  const rs = wb.addWorksheet('확인 사항');
  rs.getRow(1).values = ['구분', '내용'].map(t);
  rs.getRow(1).font = { bold: true };
  r.review.forEach((x, i) => (rs.getRow(2 + i).values = [x.severity === 'blocking' ? '반드시 고칠 것' : x.severity === 'warning' ? '확인 필요' : '참고', x.message].map(t)));
  rs.getColumn(2).width = 110;

  const ns = wb.addWorksheet('계산 근거');
  const lines = [...r.notes, `적용 기준 자료: ${r.rules.length ? r.rules.join(', ') : '없음'}`, ...r.unreadable.map((u) => `읽지 못한 금액: ${u.source} ${u.row}행 "${u.text}"`)];
  lines.forEach((l, i) => (ns.getCell(`A${i + 1}`).value = t(l)));
  ns.getColumn(1).width = 120;

  return Buffer.from(await wb.xlsx.writeBuffer());
}
