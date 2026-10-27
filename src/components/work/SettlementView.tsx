'use client';

import { Card } from './WorkShell';
import type { SettlementDto } from './types';

const TX_FLAG: Record<string, string> = {
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
const won = (n: number | null) => (n === null ? '—' : `${n.toLocaleString('ko-KR')}원`);

/** 대사 결과 — 숫자는 원자료에서 프로그램이 맞춘 값(AI가 만든 숫자 아님). 비용 인정·지급은 담당자가 정한다 */
export default function SettlementView({ data }: { data: SettlementDto }) {
  const flagged = data.transactions.filter((t) => t.flags.some((f) => f !== 'canceled'));
  return (
    <Card>
      <h2 className="text-[16px] font-semibold">예산·집행·증빙 대사</h2>
      <p className="mt-1 text-[13px] text-slate-600">숫자는 원자료에서 프로그램이 맞췄습니다(AI가 만든 숫자 아님). 대사 결과일 뿐이며 비용 인정·지급·전표 입력은 담당자가 정합니다.</p>
      <dl className="mt-3 grid grid-cols-2 gap-2 text-[14px] md:grid-cols-4">
        {[
          ['예산', won(data.totals.budget)],
          ['순집행', won(data.totals.executed)],
          ['잔액', won(data.totals.balance)],
          ['증빙 없는 집행', won(data.totals.unevidenced)],
        ].map(([k, v]) => (
          <div key={k} className="rounded-lg bg-slate-50 px-3 py-2">
            <dt className="text-[12px] text-slate-500">{k}</dt>
            <dd className="font-semibold">{v}</dd>
          </div>
        ))}
      </dl>
      <div className="mt-4 overflow-x-auto">
        <table className="w-full min-w-[480px] border-collapse text-[13px]">
          <caption className="mb-1 text-left text-[14px] font-medium">예산 과목별 잔액</caption>
          <thead>
            <tr className="border-b border-[#DCE3EC] text-left text-slate-600">
              <th scope="col" className="px-2 py-1.5">과목</th>
              <th scope="col" className="px-2 py-1.5 text-right">예산</th>
              <th scope="col" className="px-2 py-1.5 text-right">순집행</th>
              <th scope="col" className="px-2 py-1.5 text-right">잔액</th>
            </tr>
          </thead>
          <tbody>
            {data.budget.map((b) => (
              <tr key={b.item} className="border-b border-slate-100">
                <td className="px-2 py-1.5">{b.item}</td>
                <td className="px-2 py-1.5 text-right">{b.budget === null ? '예산표에 없음' : won(b.budget)}</td>
                <td className="px-2 py-1.5 text-right">{won(b.executed)}</td>
                <td className={`px-2 py-1.5 text-right ${b.balance !== null && b.balance < 0 ? 'font-semibold text-red-700' : ''}`}>{won(b.balance)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="mt-4 overflow-x-auto">
        <table className="w-full min-w-[640px] border-collapse text-[13px]">
          <caption className="mb-1 text-left text-[14px] font-medium">확인할 거래 {flagged.length}건 (전체 {data.transactions.length}건은 대사표 엑셀에)</caption>
          <thead>
            <tr className="border-b border-[#DCE3EC] text-left text-slate-600">
              <th scope="col" className="px-2 py-1.5">번호</th>
              <th scope="col" className="px-2 py-1.5">일자</th>
              <th scope="col" className="px-2 py-1.5">적요</th>
              <th scope="col" className="px-2 py-1.5">거래처</th>
              <th scope="col" className="px-2 py-1.5 text-right">금액</th>
              <th scope="col" className="px-2 py-1.5">증빙</th>
              <th scope="col" className="px-2 py-1.5">확인</th>
            </tr>
          </thead>
          <tbody>
            {flagged.slice(0, 50).map((t) => (
              <tr key={t.id} className="border-b border-slate-100 align-top">
                <td className="px-2 py-1.5 font-medium">{t.id}</td>
                <td className="whitespace-nowrap px-2 py-1.5">{t.date ?? '—'}</td>
                <td className="px-2 py-1.5">{t.desc || t.item}</td>
                <td className="px-2 py-1.5">{t.vendor || '—'}</td>
                <td className="whitespace-nowrap px-2 py-1.5 text-right">{won(t.amount)}</td>
                <td className="px-2 py-1.5">{t.evidenceId ?? '—'}</td>
                <td className="px-2 py-1.5 text-amber-800">{t.flags.filter((f) => f !== 'canceled').map((f) => TX_FLAG[f] ?? f).join(', ')}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Card>
  );
}
