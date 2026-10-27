import { describe, it, expect } from 'vitest';
import ExcelJS from 'exceljs';
import { readAttachment } from '@/lib/attachments/reader';
import { reconcile, parseReceiptText, type SettleSource } from '@/lib/work/workflows/settlement/reconcile';
import { buildSettlementWorkbook } from '@/lib/work/workflows/settlement/workbook';
import { factLines, qaReviewItems, removeForeignPii, verifyQa } from '@/lib/work/workflows/qa/verify';
import { auditFieldValues, buildAuditIndexWorkbook, replyFieldValues } from '@/lib/work/workflows/qa/output';
import { parseQa, mockQaModel } from '@/lib/work/workflows/qa/model';
import { satisfiesFileSet, uploadPurposeOf } from '@/lib/work/file-sets';
import { WorkError } from '@/lib/work/types';
import { hotelReceipt, settlementWorkbooks } from './helpers/settlement-fixture';

/**
 * P5 — 예산·정산 대사(A18: 취소·중복 영수증·불일치, 자동 지급 없음)와 질문별 답변(A19: 복합 문의·감사 요구 — 항목별 대응·증빙·빠진 사실).
 * 대사는 실제 XLSX를 첨부 읽기(readAttachment)로 읽은 표로 돌린다(손으로 만든 표가 아님).
 */
async function settleSources(opts: { ocr?: boolean } = {}): Promise<SettleSource[]> {
  const { budgetLedger, evidenceList } = await settlementWorkbooks();
  const a = await readAttachment(budgetLedger, '예산·집행.xlsx');
  const e = await readAttachment(evidenceList, '카드 매출전표.xlsx');
  return [
    { id: 's1', name: '예산·집행.xlsx', purpose: 'data', text: a.text, tables: a.tables, warnings: a.warnings },
    { id: 's2', name: '카드 매출전표.xlsx', purpose: 'evidence', text: e.text, tables: e.tables, warnings: e.warnings },
    { id: 's3', name: '호텔 영수증.pdf', purpose: 'evidence', text: hotelReceipt, tables: [], warnings: opts.ocr ? ['글자 층이 없는 PDF라 글자 인식(OCR)으로 읽었습니다 — 숫자·글자가 원문과 다를 수 있습니다'] : [] },
    { id: 's4', name: '여비 지급 기준.hwpx', purpose: 'reference', text: '숙박비 상한 …', tables: [], warnings: [] },
  ];
}

describe('예산·정산 대사 — A18', () => {
  it('영수증 글에서 합계·날짜·상호·승인번호를 읽는다(합계가 공급가액보다 먼저)', () => {
    expect(parseReceiptText(hotelReceipt)).toEqual({ amount: 330_000, date: '2026-09-20', vendor: '바호텔', evidenceNo: '77881234' });
    expect(parseReceiptText('글만 있음').amount).toBeNull();
  });

  it('취소는 짝지어 순액 0, 중복 거래·중복 영수증·분할·부가세·증빙 없음·예산 초과를 알리고 지급은 하지 않는다', async () => {
    const r = reconcile({ sources: await settleSources({ ocr: true }), period: '2026년 9월' });
    const tx = Object.fromEntries(r.transactions.map((t) => [t.id, t]));
    expect(r.transactions).toHaveLength(9); // 합계 행은 거래가 아니다
    expect(tx.T3.flags).toEqual(['canceled']);
    expect(tx.T4.flags).toEqual(['canceled']);
    expect(tx.T2.flags).toContain('duplicate_candidate');
    expect(tx.T1.evidenceId).toBe('R1');
    expect(tx.T5.flags).toEqual(expect.arrayContaining(['vat_diff', 'split_candidate']));
    expect(tx.T6.evidenceId).toBe('R4');
    expect(tx.T7.flags).toContain('unevidenced');
    expect(tx.T8.evidenceId).toBe('R7'); // 영수증 글 한 장
    expect(tx.T8.flags).toContain('ocr_amount');
    expect(r.evidence.find((e) => e.id === 'R3')!.flags).toContain('duplicate_receipt');
    expect(r.evidence.find((e) => e.id === 'R6')!.flags).toContain('unmatched');
    // 순집행: 취소 짝(59,800 ↔ −59,800)은 빠지고 중복 의심 거래는 자동으로 빼지 않는다
    expect(r.totals.executed).toBe(120_000 + 120_000 + 110_000 + 90_000 + 45_000 + 330_000 + 90_000);
    const meeting = r.budget.find((b) => b.item === '회의비')!;
    expect(meeting).toEqual({ item: '회의비', budget: 300_000, executed: 375_000, balance: -75_000 });
    const codes = r.review.map((x) => x.code);
    expect(codes).toEqual(expect.arrayContaining(['OVER_BUDGET', 'DUPLICATE_TRANSACTION', 'DUPLICATE_RECEIPT', 'SPLIT_CANDIDATE', 'VAT_DIFF', 'UNEVIDENCED', 'OCR_AMOUNT', 'UNMATCHED_EVIDENCE', 'SCOPE']));
    expect(r.review.find((x) => x.code === 'OVER_BUDGET')!.severity).toBe('blocking');
    expect(r.review.find((x) => x.code === 'SCOPE')!.message).toContain('비용 인정 여부·지급·전표 입력은 담당자가');
    expect(r.rules).toEqual(['여비 지급 기준.hwpx']);
  });

  it('원거래가 없는 취소·천원 단위 열·읽지 못한 금액', () => {
    const table = (columns: string[], rows: (string | number | null)[][]) => ({ id: 't1', title: 't', cells: [columns, ...rows], merges: [], header: { from: 0, to: 0 }, columns });
    const r = reconcile({
      sources: [
        { id: 'a', name: 'a.xlsx', purpose: 'data', text: '', warnings: [], tables: [table(['일자', '과목', '적요', '금액(천원)'], [['2026-09-01', '여비', '취소', -50], ['2026-09-02', '여비', '택시', 12], ['2026-09-03', '여비', '버스', '확인중']])] },
      ],
      period: '9월',
    });
    expect(r.transactions.map((t) => t.amount)).toEqual([-50_000, 12_000]);
    expect(r.transactions[0].flags).toContain('cancel_unpaired');
    expect(r.unreadable).toEqual([{ source: 'a.xlsx', row: 4, text: '확인중' }]);
    expect(r.review.map((x) => x.code)).toEqual(expect.arrayContaining(['NO_BUDGET', 'CANCEL_UNPAIRED', 'UNREADABLE_AMOUNT', 'UNEVIDENCED']));
  });

  it('대사표 엑셀 — 다섯 시트, 값만(수식 없음), 금액은 숫자', async () => {
    const r = reconcile({ sources: await settleSources(), period: '2026년 9월' });
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load((await buildSettlementWorkbook({ title: '9월 정산', period: '2026년 9월', result: r, createdAt: new Date() })) as unknown as ArrayBuffer);
    expect(wb.worksheets.map((w) => w.name)).toEqual(['대사표', '예산 잔액', '증빙 목록', '확인 사항', '계산 근거']);
    expect(wb.getWorksheet('대사표')!.getRow(4).getCell(6).value).toBe(120_000);
    let formulas = 0;
    wb.eachSheet((s) => s.eachRow((row) => row.eachCell((c) => { if (c.formula) formulas++; })));
    expect(formulas).toBe(0);
  });

  it('파일 입력 → 원자료 용도는 한 표(화면·서버 공용)', () => {
    expect(uploadPurposeOf('budgetFiles')).toBe('data');
    expect(uploadPurposeOf('evidenceFiles')).toBe('evidence');
    expect(uploadPurposeOf('sourceFiles')).toBe('reference');
    expect(satisfiesFileSet('evidenceFiles', 'data')).toBe(false);
    expect(satisfiesFileSet('sourceFiles', 'data')).toBe(true);
    expect(satisfiesFileSet('sourceFiles', 'template')).toBe(false);
  });
});

describe('질문별 답변 — A19', () => {
  const inquiry = '안녕하세요. 주차장 이용 시간을 늘릴 수 있나요? 그리고 지난주 신고한 야간 조명 고장은 언제 고쳐지나요? 회신은 010-1111-2222로 주세요.';
  const facts = factLines('- 주차장 운영 시간은 07시~22시이며 연장 계획은 확정되지 않음\n- 야간 조명은 10월 20일 교체 완료');
  const q = [{ id: 'inquiry', name: '문의 내용', text: inquiry }];

  it('사실 줄 번호·다른 사람 개인정보 지우기(민원인 본인 연락처는 남김)', () => {
    expect(facts.map((f) => f.id)).toEqual(['F1', 'F2']);
    expect(removeForeignPii('010-1111-2222로 연락드렸고 김씨(010-3333-4444, kim@ex.kr)도', inquiry)).toEqual({ text: '010-1111-2222로 연락드렸고 김씨([개인정보 삭제], [개인정보 삭제])도', removed: 2 });
  });

  it('회신 — 답이 빠진 질문은 반드시 고칠 것, 확인 사실에 없는 약속·다른 사람 정보·근거 없음은 확인 필요', () => {
    const r = verifyQa(
      {
        questions: [
          { text: '주차장 이용 시간 연장', quote: '주차장 이용 시간을 늘릴 수 있나요?', sourceId: 'inquiry' },
          { text: '야간 조명 수리 시기', quote: '야간 조명 고장은 언제 고쳐지나요?', sourceId: 'inquiry' },
          { text: '주차 요금 감면', quote: '감면 받을 수 있나요?', sourceId: 'inquiry' },
        ],
        answers: [
          { question: 1, text: '현재 07시~22시 운영하며, 11월까지 연장 조치하겠습니다.', evidence: ['F1'], status: 'answered' },
          { question: 2, text: '10월 20일 교체를 마쳤습니다. 같은 건으로 문의한 박민원(010-5555-6666)님께도 안내했습니다.', evidence: ['F2'], status: 'answered' },
        ],
        priorDiffs: [],
      },
      { kind: 'reply', questionSources: q, evidenceSources: [], priorSources: [], facts, inquiryText: inquiry, definitionsText: '' }
    );
    expect(r.pairs.map((p) => [p.id, p.flags])).toEqual([
      ['Q1', ['promise_unsupported']],
      ['Q2', ['pii_removed']],
      ['Q3', ['quote_not_found', 'unanswered']],
    ]);
    expect(r.pairs[1].answer).toContain('[개인정보 삭제]');
    expect(r.pairs[1].answer).not.toContain('010-5555-6666');
    const items = qaReviewItems(r);
    expect(items.find((i) => i.code === 'QA_UNANSWERED')!.severity).toBe('blocking');
    expect(items.map((i) => i.code)).toEqual(expect.arrayContaining(['QA_PROMISE_UNSUPPORTED', 'QA_PII_REMOVED']));
    const f = replyFieldValues(r, { title: '주차장 문의 회신', recipient: '민원인', today: '2026. 10. 27.', departmentName: '시설관리과' });
    expect(f['답변']).toContain('3. 주차 요금 감면\n→ (답변 없음 — 확인 필요)');
    expect(f['관련 근거']).toContain('[F1] 담당자 확인 사실: 주차장 운영 시간은 07시~22시');
    expect(f['추가 확인 필요']).toContain('Q3');
    expect(f['담당 부서']).toBe('시설관리과');
    expect('연락처' in f).toBe(false);
  });

  it('감사 — 증빙 없는 주장·지표 정의 밖 연도·근거 없는 과거 수치 차이, 증빙목록 엑셀', async () => {
    const req = { id: 'r1', name: '요구서.hwpx', text: '1. 2026년 1~9월 민원 평균 처리 기간\n2. 민원 만족도 조사 결과' };
    const ev = { id: 'e1', name: '민원 처리 실적.xlsx', text: '평균 처리 기간 4.2일(2026년 1~9월)' };
    const prior = { id: 'p1', name: '2025 제출본.hwpx', text: '평균 처리 기간 4.8일' };
    const r = verifyQa(
      {
        questions: [
          { text: '민원 평균 처리 기간', quote: '2026년 1~9월 민원 평균 처리 기간', sourceId: 'r1' },
          { text: '만족도 조사 결과', quote: '민원 만족도 조사 결과', sourceId: 'r1' },
        ],
        answers: [
          { question: 1, text: '2026년 1~9월 평균 4.2일입니다(2024년 대비 단축).', evidence: ['e1'], status: 'answered' },
          { question: 2, text: '만족도는 92점입니다.', evidence: [], status: 'answered' },
        ],
        priorDiffs: [{ question: 1, label: '평균 처리 기간', current: '4.2일', prior: '4.8일', reason: '' }],
      },
      { kind: 'audit', questionSources: [req], evidenceSources: [ev], priorSources: [prior], facts: [], inquiryText: '', definitionsText: '민원 처리 기간(2026년 1~9월)' }
    );
    expect(r.pairs[0].flags).toEqual(expect.arrayContaining(['year_mismatch', 'prior_diff_unexplained']));
    expect(r.pairs[1].flags).toEqual(['unsupported']);
    const f = auditFieldValues(r, { title: '민원 실적 요구자료', organizationName: '가상공공지원재단', definitions: ['민원 처리 기간(2026년 1~9월)'] });
    expect(f['요구 항목별 답변']).toContain('[증빙: 민원 처리 실적.xlsx]');
    expect(f['요구 항목별 답변']).toContain('[증빙 없음]');
    expect(f['확인 필요 사항']).toContain('과거 4.8일 → 지금 4.2일 — 차이 근거 필요');
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load((await buildAuditIndexWorkbook({ title: 't', result: r, review: qaReviewItems(r), createdAt: new Date(), testMode: false })) as unknown as ArrayBuffer);
    expect(wb.worksheets.map((w) => w.name)).toEqual(['증빙목록·수치 대조', '확인 사항']);
    expect((wb.worksheets[0].getRow(5).values as string[]).slice(1)[3]).toBe('증빙 없음');
  });

  it('모델 출력 다듬기·시험 모드', async () => {
    expect(parseQa('x {"questions":[{"text":"a","quote":"b","sourceId":"s"},{"text":""}],"answers":[{"question":"1","text":"t","evidence":["F1",3]}]}')).toEqual({
      questions: [{ text: 'a', quote: 'b', sourceId: 's' }],
      answers: [{ question: 1, text: 't', evidence: ['F1'], status: '' }],
      priorDiffs: [],
    });
    expect(() => parseQa('없음')).toThrow(WorkError);
    const m = await mockQaModel.answer({ kind: 'reply', title: 't', questionSources: q, evidenceSources: [], priorSources: [], facts, definitions: [] }, { model: 'm' });
    const r = verifyQa(m.raw, { kind: 'reply', questionSources: q, evidenceSources: [], priorSources: [], facts, inquiryText: inquiry, definitionsText: '' });
    expect(r.pairs.length).toBeGreaterThan(1);
    expect(r.pairs.every((p) => p.evidence[0]?.id === 'F1' && p.answer.includes('[시험 모드]'))).toBe(true);
  });
});
