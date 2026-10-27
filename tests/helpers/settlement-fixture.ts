import ExcelJS from 'exceljs';

/**
 * 가상 정산 자료(실제 기관·사람 아님) — 시나리오 A18: 취소·중복 영수증·불일치.
 *  T1·T2 같은 날 같은 금액 같은 거래처(중복 의심) / T3·T4 KTX 결제와 취소(짝) / T5 증빙이 공급가액(부가세 차이) /
 *  T5·T6 같은 거래처 7일 안(분할 의심) / T7 증빙 없음 / T8 숙박(영수증 글 한 장) / T9 회의비 예산 초과
 *  증빙: R-002가 두 번(중복 영수증), 대응 거래 없는 마트 영수증
 */
export const budgetRows: [string, number][] = [
  ['여비', 500_000],
  ['회의비', 300_000],
  ['사무용품비', 250_000],
];

export const ledgerRows: [string, string, string, string, number, string][] = [
  ['2026-09-02', '회의비', '간담회 식대', '가나식당', 120_000, 'R-001'],
  ['2026-09-02', '회의비', '간담회 식대', '가나식당', 120_000, ''],
  ['2026-09-05', '여비', 'KTX 왕복', '코레일', 59_800, ''],
  ['2026-09-06', '여비', 'KTX 왕복 취소', '코레일', -59_800, ''],
  ['2026-09-10', '사무용품비', '복사용지', '다라문구', 110_000, ''],
  ['2026-09-11', '사무용품비', '토너', '다라문구', 90_000, 'R-003'],
  ['2026-09-15', '회의비', '다과', '라마상회', 45_000, ''],
  ['2026-09-20', '여비', '출장 숙박', '바호텔', 330_000, ''],
  ['2026-09-25', '회의비', '위원회 식대', '가나식당', 90_000, 'R-005'],
];

export const evidenceRows: [string, string, string, number][] = [
  ['R-001', '2026-09-02', '가나식당', 120_000],
  ['R-002', '2026-09-10', '다라문구', 100_000],
  ['R-002', '2026-09-10', '다라문구', 100_000],
  ['R-003', '2026-09-11', '다라문구', 90_000],
  ['R-005', '2026-09-25', '가나식당', 90_000],
  ['R-009', '2026-09-28', '사마마트', 12_000],
];

export const hotelReceipt = '영 수 증\n상호: 바호텔\n일시: 2026-09-20 21:14\n객실 1박\n공급가액 300,000원\n부가세 30,000원\n합계 330,000원\n승인번호: 77881234';

export async function settlementWorkbooks(): Promise<{ budgetLedger: Buffer; evidenceList: Buffer }> {
  const a = new ExcelJS.Workbook();
  const b = a.addWorksheet('예산');
  b.addRow(['예산과목', '예산액(원)']);
  budgetRows.forEach((r) => b.addRow(r));
  const l = a.addWorksheet('집행 내역');
  l.addRow(['집행일자', '예산과목', '적요', '거래처', '금액(원)', '증빙번호']);
  ledgerRows.forEach((r) => l.addRow(r));
  l.addRow(['', '합계', '', '', ledgerRows.reduce((s, r) => s + r[4], 0), '']);
  const e = new ExcelJS.Workbook();
  const es = e.addWorksheet('카드 매출전표');
  es.addRow(['증빙번호', '사용일', '가맹점', '금액']);
  evidenceRows.forEach((r) => es.addRow(r));
  return { budgetLedger: Buffer.from(await a.xlsx.writeBuffer()), evidenceList: Buffer.from(await e.xlsx.writeBuffer()) };
}
