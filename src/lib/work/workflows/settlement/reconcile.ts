// src/lib/work/workflows/settlement/reconcile.ts
import type { ExtractedTable } from '@/lib/attachments/types';
import { parseNumber } from '@/lib/table-engine/number';
import { normalizeDate } from '../regulations/evidence';

/**
 * 예산·정산 대사(순수 함수 — 모델을 부르지 않는다. 숫자는 프로그램만 낸다).
 *
 * 지키는 것(카탈로그 validationRules: 취소·중복·분할 집행 / 부가세·단위·OCR 불확실성 / 거래·증빙 대응과 잔액):
 *  - 취소 거래는 원거래와 짝지어 순액 0으로, 짝이 없으면 알린다
 *  - 같은 날·같은 금액·같은 거래처 거래, 같은 증빙(번호·금액·날짜)은 중복 후보로 알린다(자동으로 빼지 않는다)
 *  - 증빙 금액이 거래의 1.1배·1/1.1(부가세)·1,000배(단위)면 대응은 하되 차이를 알린다. OCR로 읽은 금액은 원본 확인
 *  - 예산 과목별 잔액 = 예산 − 순집행. 초과면 반드시 고칠 것
 *  - 비용 인정 확정·지급·전표 입력은 하지 않는다(카탈로그 scopeNote) — 결과는 대사·검토 항목뿐
 */
export interface SettleSource {
  id: string;
  name: string;
  /** data = 승인 예산·집행 자료, evidence = 증빙, reference = 적용 기준 */
  purpose: string;
  text: string;
  tables: ExtractedTable[];
  warnings: string[];
}

export type TxFlag = 'canceled' | 'cancel_unpaired' | 'duplicate_candidate' | 'split_candidate' | 'unevidenced' | 'evidence_reused' | 'vat_diff' | 'unit_diff' | 'ocr_amount' | 'not_in_budget';
export type EvFlag = 'unmatched' | 'duplicate_receipt' | 'ocr_amount' | 'amount_unread';

export interface Transaction {
  id: string;
  source: string;
  row: number;
  date: string | null;
  item: string;
  desc: string;
  vendor: string;
  amount: number;
  evidenceNo: string;
  cancel: boolean;
  /** 짝지은 증빙 id */
  evidenceId: string | null;
  /** 취소 짝(원거래 ↔ 취소 거래) */
  pairId: string | null;
  flags: TxFlag[];
}

export interface Evidence {
  id: string;
  source: string;
  row: number | null;
  date: string | null;
  vendor: string;
  amount: number | null;
  evidenceNo: string;
  ocr: boolean;
  transactionIds: string[];
  flags: EvFlag[];
}

export interface BudgetLine {
  item: string;
  budget: number | null;
  executed: number;
  balance: number | null;
}

export interface SettlementReview {
  severity: 'blocking' | 'warning' | 'info';
  code: string;
  message: string;
}

export interface SettlementResult {
  schema: 'settlement/1';
  transactions: Transaction[];
  evidence: Evidence[];
  budget: BudgetLine[];
  totals: { budget: number | null; executed: number; balance: number | null; evidenced: number; unevidenced: number };
  rules: string[];
  unreadable: { source: string; row: number; text: string }[];
  review: SettlementReview[];
  notes: string[];
}

const COL = {
  date: /일자|날짜|지출일|집행일|결제일|거래일|사용일/,
  amount: /금액|집행액|지출액|결제액|청구액|사용액|합계/,
  budget: /예산/,
  item: /과목|비목|세목|예산항목|항목/,
  desc: /적요|내용|사용\s*내역|내역|용도/,
  vendor: /거래처|가맹점|상호|업체|지급처|공급자/,
  evidenceNo: /증빙\s*번호|영수증\s*번호|승인\s*번호|증빙|전표/,
  status: /구분|상태|비고/,
};

function col(columns: string[], re: RegExp, not?: RegExp): number {
  return columns.findIndex((c) => re.test(c) && !(not && not.test(c)));
}

/** 열 이름·표 위 글의 단위 — 천원·백만원이면 원으로 바꾼다(모르면 1) */
function unitScale(name: string, caption: string | undefined): number {
  const s = `${name} ${caption ?? ''}`;
  if (/백만\s*원/.test(s)) return 1_000_000;
  if (/천\s*원/.test(s)) return 1_000;
  return 1;
}

function cellText(v: unknown): string {
  return v === null || v === undefined ? '' : String(v).trim();
}

function dataRows(t: ExtractedTable): { row: number; cells: (string | number | null)[] }[] {
  return t.cells.slice(t.header.to + 1).map((cells, i) => ({ row: t.header.to + 2 + i, cells })).filter((r) => r.cells.some((c) => cellText(c) !== ''));
}

const TOTAL_ROW = /^(합\s*계|소\s*계|총\s*계|계|total)$/i;

function amountOf(v: string | number | null, scale: number): number | null {
  const p = parseNumber(v);
  if (p.kind !== 'number') return null;
  const unit = p.unit === '천원' ? 1_000 : p.unit === '백만원' ? 1_000_000 : 1;
  return Math.round(p.value * (p.unit ? unit : scale));
}

const AMOUNT_KEY = /(합\s*계|총\s*액|결제\s*금액|청구\s*금액|받을\s*금액|승인\s*금액|금\s*액)\s*[:：]?\s*(?:₩|\\)?\s*([0-9][0-9,]*)\s*원?/g;
const ANY_WON = /([0-9]{1,3}(?:,[0-9]{3})+|[0-9]{3,})\s*원/g;
const DATE_RE = /(20\d{2})\s*[-./년]\s*(\d{1,2})\s*[-./월]\s*(\d{1,2})/;

/** 영수증 한 장의 글 → 금액·날짜·상호·번호. 금액은 '합계·결제금액…' 뒤 숫자가 먼저, 없으면 '원'이 붙은 가장 큰 숫자 */
export function parseReceiptText(text: string): { amount: number | null; date: string | null; vendor: string; evidenceNo: string } {
  const keyed = [...text.matchAll(AMOUNT_KEY)].map((m) => Number(m[2].replace(/,/g, ''))).filter((n) => Number.isFinite(n) && n > 0);
  const won = [...text.matchAll(ANY_WON)].map((m) => Number(m[1].replace(/,/g, ''))).filter((n) => Number.isFinite(n) && n > 0);
  const amount = keyed.length ? Math.max(...keyed) : won.length ? Math.max(...won) : null;
  const d = DATE_RE.exec(text);
  const date = d ? normalizeDate(`${d[1]}-${d[2]}-${d[3]}`) : null;
  const vendor = /(?:상호|가맹점명?|거래처|공급자)\s*[:：]?\s*([^\n,]{1,40})/.exec(text)?.[1]?.trim() ?? '';
  const evidenceNo = /(?:승인\s*번호|영수증\s*번호|증빙\s*번호)\s*[:：]?\s*([A-Za-z0-9-]{3,30})/.exec(text)?.[1] ?? '';
  return { amount, date, vendor, evidenceNo };
}

const squash = (s: string) => s.replace(/\s+/g, '').toLowerCase();
const sameVendor = (a: string, b: string) => Boolean(a && b) && (squash(a) === squash(b) || squash(a).includes(squash(b)) || squash(b).includes(squash(a)));
const dayDiff = (a: string | null, b: string | null) => (a && b ? Math.abs(Date.parse(a) - Date.parse(b)) / 86_400_000 : Infinity);

export function reconcile(input: { sources: SettleSource[]; period: string }): SettlementResult {
  const txs: Transaction[] = [];
  const budget = new Map<string, number | null>();
  const evidence: Evidence[] = [];
  const unreadable: SettlementResult['unreadable'] = [];
  const notes: string[] = [];
  const review: SettlementReview[] = [];

  // ── 1. 예산표·집행 내역(승인 예산·집행 자료) ──
  for (const s of input.sources.filter((x) => x.purpose === 'data')) {
    for (const t of s.tables) {
      const c = t.columns;
      const iDate = col(c, COL.date);
      const iAmount = col(c, COL.amount, COL.budget);
      const iBudget = col(c, COL.budget, COL.item); // '예산과목'은 과목 열이다(예산액 열과 헷갈리지 않게)
      const iItem = col(c, COL.item);
      if (iDate >= 0 && iAmount >= 0) {
        const scale = unitScale(c[iAmount], t.caption);
        const iDesc = col(c, COL.desc);
        const iVendor = col(c, COL.vendor);
        const iNo = col(c, COL.evidenceNo);
        const iStatus = col(c, COL.status);
        for (const r of dataRows(t)) {
          const first = cellText(r.cells[iItem >= 0 ? iItem : 0]);
          if (TOTAL_ROW.test(first.replace(/\s+/g, '')) || TOTAL_ROW.test(cellText(r.cells[iDesc]).replace(/\s+/g, ''))) continue;
          const amount = amountOf(r.cells[iAmount], scale);
          if (amount === null) {
            unreadable.push({ source: s.name, row: r.row, text: cellText(r.cells[iAmount]).slice(0, 40) });
            continue;
          }
          const status = iStatus >= 0 ? cellText(r.cells[iStatus]) : '';
          const desc = iDesc >= 0 ? cellText(r.cells[iDesc]) : '';
          txs.push({
            id: `T${txs.length + 1}`,
            source: s.name,
            row: r.row,
            date: normalizeDate(cellText(r.cells[iDate])),
            item: iItem >= 0 ? cellText(r.cells[iItem]) : '',
            desc,
            vendor: iVendor >= 0 ? cellText(r.cells[iVendor]) : '',
            amount,
            evidenceNo: iNo >= 0 ? cellText(r.cells[iNo]) : '',
            cancel: amount < 0 || /취소/.test(`${status} ${desc}`),
            evidenceId: null,
            pairId: null,
            flags: [],
          });
        }
      } else if (iItem >= 0 && iBudget >= 0 && iDate < 0) {
        const scale = unitScale(c[iBudget], t.caption);
        for (const r of dataRows(t)) {
          const item = cellText(r.cells[iItem]);
          if (!item || TOTAL_ROW.test(item.replace(/\s+/g, ''))) continue;
          const amount = amountOf(r.cells[iBudget], scale);
          if (amount === null) unreadable.push({ source: s.name, row: r.row, text: cellText(r.cells[iBudget]).slice(0, 40) });
          budget.set(item, (budget.get(item) ?? 0) + (amount ?? 0));
        }
      }
    }
  }

  // ── 2. 증빙 — 표(카드 전표 목록 등)는 줄마다, 글뿐인 파일(영수증 한 장)은 파일마다 ──
  for (const s of input.sources.filter((x) => x.purpose === 'evidence')) {
    const ocr = s.warnings.some((w) => /OCR|글자 인식/.test(w));
    let fromTable = false;
    for (const t of s.tables) {
      const c = t.columns;
      const iAmount = col(c, COL.amount);
      if (iAmount < 0) continue;
      fromTable = true;
      const scale = unitScale(c[iAmount], t.caption);
      const iDate = col(c, COL.date);
      const iVendor = col(c, COL.vendor);
      const iNo = col(c, COL.evidenceNo);
      for (const r of dataRows(t)) {
        if (TOTAL_ROW.test(cellText(r.cells[0]).replace(/\s+/g, ''))) continue;
        const amount = amountOf(r.cells[iAmount], scale);
        evidence.push({
          id: `R${evidence.length + 1}`,
          source: s.name,
          row: r.row,
          date: iDate >= 0 ? normalizeDate(cellText(r.cells[iDate])) : null,
          vendor: iVendor >= 0 ? cellText(r.cells[iVendor]) : '',
          amount,
          evidenceNo: iNo >= 0 ? cellText(r.cells[iNo]) : '',
          ocr,
          transactionIds: [],
          flags: amount === null ? ['amount_unread'] : ocr ? ['ocr_amount'] : [],
        });
      }
    }
    if (!fromTable) {
      const p = parseReceiptText(s.text);
      evidence.push({ id: `R${evidence.length + 1}`, source: s.name, row: null, date: p.date, vendor: p.vendor, amount: p.amount, evidenceNo: p.evidenceNo, ocr, transactionIds: [], flags: p.amount === null ? ['amount_unread'] : ocr ? ['ocr_amount'] : [] });
    }
  }
  const rules = input.sources.filter((x) => x.purpose === 'reference').map((x) => x.name);

  // ── 3. 취소 짝 ──
  for (const c of txs.filter((t) => t.cancel)) {
    const abs = Math.abs(c.amount);
    const orig = txs.find((t) => !t.cancel && !t.pairId && t.amount === abs && (sameVendor(t.vendor, c.vendor) || (!t.vendor && !c.vendor && t.item === c.item)));
    if (orig) {
      orig.pairId = c.id;
      c.pairId = orig.id;
      orig.flags.push('canceled');
      c.flags.push('canceled');
    } else c.flags.push('cancel_unpaired');
  }
  const live = txs.filter((t) => !t.pairId && !t.cancel);

  // ── 4. 중복 거래·분할 집행 후보 ──
  live.forEach((t, i) => {
    const dup = live.slice(0, i).find((u) => u.date && u.date === t.date && u.amount === t.amount && sameVendor(u.vendor, t.vendor));
    if (dup) t.flags.push('duplicate_candidate');
  });
  for (const t of live) {
    if (!t.vendor) continue;
    const near = live.filter((u) => u !== t && sameVendor(u.vendor, t.vendor) && dayDiff(u.date, t.date) <= 7);
    if (near.length && !t.flags.includes('duplicate_candidate') && near.some((u) => !u.flags.includes('duplicate_candidate'))) t.flags.push('split_candidate');
  }

  // ── 5. 중복 증빙 ──
  evidence.forEach((e, i) => {
    const dup = evidence.slice(0, i).find((f) => (e.evidenceNo && f.evidenceNo === e.evidenceNo) || (e.amount !== null && f.amount === e.amount && e.date && f.date === e.date && sameVendor(f.vendor, e.vendor)));
    if (dup) e.flags.push('duplicate_receipt');
  });

  // ── 6. 거래 ↔ 증빙 대응 ──
  const candidates = (t: Transaction) => evidence.filter((e) => !e.flags.includes('duplicate_receipt') && e.amount !== null);
  for (const t of live) {
    const pool = candidates(t);
    let hit = t.evidenceNo ? pool.find((e) => e.evidenceNo && e.evidenceNo === t.evidenceNo) : undefined;
    let flag: TxFlag | null = null;
    if (!hit) hit = pool.find((e) => e.amount === t.amount && dayDiff(e.date, t.date) <= 3 && (!e.vendor || !t.vendor || sameVendor(e.vendor, t.vendor)) && !e.transactionIds.length);
    if (!hit) {
      hit = pool.find((e) => !e.transactionIds.length && dayDiff(e.date, t.date) <= 3 && (Math.round(t.amount * 1.1) === e.amount || Math.round(e.amount! * 1.1) === t.amount));
      if (hit) flag = 'vat_diff';
    }
    if (!hit) {
      hit = pool.find((e) => !e.transactionIds.length && dayDiff(e.date, t.date) <= 3 && (t.amount * 1000 === e.amount || e.amount! * 1000 === t.amount));
      if (hit) flag = 'unit_diff';
    }
    if (!hit) {
      t.flags.push('unevidenced');
      continue;
    }
    if (hit.transactionIds.length) t.flags.push('evidence_reused');
    hit.transactionIds.push(t.id);
    t.evidenceId = hit.id;
    if (flag) t.flags.push(flag);
    if (hit.ocr) t.flags.push('ocr_amount');
  }
  for (const e of evidence) if (!e.transactionIds.length && !e.flags.includes('duplicate_receipt')) e.flags.push('unmatched');

  // ── 7. 예산 과목별 잔액 ──
  const executedBy = new Map<string, number>();
  for (const t of live) executedBy.set(t.item, (executedBy.get(t.item) ?? 0) + t.amount);
  const items = [...new Set([...budget.keys(), ...executedBy.keys()])];
  const lines: BudgetLine[] = items.map((item) => {
    const b = budget.has(item) ? budget.get(item)! : null;
    const ex = executedBy.get(item) ?? 0;
    return { item: item || '(과목 없음)', budget: b, executed: ex, balance: b === null ? null : b - ex };
  });
  for (const t of live) if (budget.size && !budget.has(t.item)) t.flags.push('not_in_budget');
  const totalBudget = budget.size ? [...budget.values()].reduce<number>((a, b) => a + (b ?? 0), 0) : null;
  const executed = live.reduce((a, t) => a + t.amount, 0);
  const evidenced = live.filter((t) => t.evidenceId).reduce((a, t) => a + t.amount, 0);

  // ── 8. 확인 사항 ──
  const ids = (list: { id: string }[]) => `${list.slice(0, 5).map((x) => x.id).join(', ')}${list.length > 5 ? ' …' : ''}`;
  const withFlag = (f: TxFlag) => txs.filter((t) => t.flags.includes(f));
  if (!txs.length) review.push({ severity: 'blocking', code: 'NO_LEDGER', message: '집행 내역 표(일자·금액 열)를 찾지 못했습니다. 승인 예산·집행 자료에 집행 내역을 올리세요.' });
  if (!budget.size) review.push({ severity: 'warning', code: 'NO_BUDGET', message: '예산표(과목·예산 열)를 찾지 못해 잔액을 계산하지 않았습니다.' });
  for (const l of lines) if (l.balance !== null && l.balance < 0) review.push({ severity: 'blocking', code: 'OVER_BUDGET', message: `'${l.item}' 집행 ${l.executed.toLocaleString('ko-KR')}원이 예산 ${l.budget!.toLocaleString('ko-KR')}원을 넘습니다(${(-l.balance).toLocaleString('ko-KR')}원 초과).` });
  const add = (f: TxFlag, sev: SettlementReview['severity'], code: string, text: string) => {
    const l = withFlag(f);
    if (l.length) review.push({ severity: sev, code, message: `${text} ${l.length}건(${ids(l)})` });
  };
  add('cancel_unpaired', 'warning', 'CANCEL_UNPAIRED', '원거래를 찾지 못한 취소 거래 — 취소 대상 거래를 확인하세요:');
  add('duplicate_candidate', 'warning', 'DUPLICATE_TRANSACTION', '같은 날·같은 금액·같은 거래처의 중복 의심 거래(자동으로 빼지 않음):');
  add('split_candidate', 'warning', 'SPLIT_CANDIDATE', '같은 거래처에 7일 안 여러 번 나눠 집행한 거래 — 분할 집행 기준에 맞는지 확인하세요:');
  add('evidence_reused', 'warning', 'EVIDENCE_REUSED', '이미 다른 거래에 쓴 증빙과 대응된 거래:');
  add('unevidenced', 'warning', 'UNEVIDENCED', '대응하는 증빙을 찾지 못한 거래:');
  add('vat_diff', 'warning', 'VAT_DIFF', '증빙 금액이 부가세(10%)만큼 다른 거래 — 공급가액·합계 중 무엇을 집행했는지 확인하세요:');
  add('unit_diff', 'warning', 'UNIT_DIFF', '증빙 금액과 단위(원·천원)가 다른 거래:');
  add('ocr_amount', 'warning', 'OCR_AMOUNT', '글자 인식(OCR)으로 읽은 증빙 금액과 대응한 거래 — 원본 증빙으로 금액을 확인하세요:');
  add('not_in_budget', 'warning', 'ITEM_NOT_IN_BUDGET', '예산표에 없는 과목의 거래:');
  const dupR = evidence.filter((e) => e.flags.includes('duplicate_receipt'));
  if (dupR.length) review.push({ severity: 'warning', code: 'DUPLICATE_RECEIPT', message: `같은 증빙(번호 또는 금액·날짜·상호)이 두 번 이상 올라왔습니다 ${dupR.length}건(${ids(dupR)}) — 중복 영수증을 확인하세요.` });
  const unm = evidence.filter((e) => e.flags.includes('unmatched'));
  if (unm.length) review.push({ severity: 'warning', code: 'UNMATCHED_EVIDENCE', message: `대응하는 거래를 찾지 못한 증빙 ${unm.length}건(${ids(unm)}).` });
  const unread = evidence.filter((e) => e.flags.includes('amount_unread'));
  if (unread.length) review.push({ severity: 'warning', code: 'EVIDENCE_AMOUNT_UNREAD', message: `금액을 읽지 못한 증빙 ${unread.length}건(${ids(unread)}) — 원본을 확인하세요.` });
  if (unreadable.length) review.push({ severity: 'warning', code: 'UNREADABLE_AMOUNT', message: `금액을 숫자로 읽지 못한 행 ${unreadable.length}개(${unreadable.slice(0, 3).map((u) => `${u.source} ${u.row}행`).join(', ')}) — 합에 넣지 않았습니다.` });
  review.push({ severity: 'info', code: 'SCOPE', message: `대사 결과일 뿐입니다 — 비용 인정 여부·지급·전표 입력은 담당자가 ${rules.length ? `적용 기준(${rules.join(', ')})에 따라 ` : ''}판단합니다.` });
  notes.push(`정산 기간: ${input.period}`, '거래 ↔ 증빙: 증빙 번호가 같으면 먼저, 아니면 같은 금액·3일 안 날짜(거래처가 둘 다 있으면 같아야 함), 그다음 부가세 10%·천원 단위 차이', '취소 거래는 같은 금액·같은 거래처의 원거래와 짝지어 순액 0');

  return {
    schema: 'settlement/1',
    transactions: txs,
    evidence,
    budget: lines,
    totals: { budget: totalBudget, executed, balance: totalBudget === null ? null : totalBudget - executed, evidenced, unevidenced: executed - evidenced },
    rules,
    unreadable,
    review,
    notes,
  };
}

export const TX_FLAG_LABEL: Record<TxFlag, string> = {
  canceled: '취소 짝',
  cancel_unpaired: '원거래 없는 취소',
  duplicate_candidate: '중복 의심',
  split_candidate: '분할 집행 의심',
  unevidenced: '증빙 없음',
  evidence_reused: '증빙 재사용',
  vat_diff: '부가세 차이',
  unit_diff: '단위 차이',
  ocr_amount: 'OCR 금액',
  not_in_budget: '예산표에 없는 과목',
};
