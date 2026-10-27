'use client';

import { Card } from './WorkShell';
import type { QaDto } from './types';

const FLAG: Record<string, string> = {
  unanswered: '답변 없음',
  needs_info: '사실 확인 필요',
  unsupported: '근거 없음',
  promise_unsupported: '근거 없는 조치·기한 약속',
  pii_removed: '다른 사람 개인정보 지움',
  year_mismatch: '연도·기준 혼합',
  prior_diff_unexplained: '과거 수치 차이 근거 필요',
  quote_not_found: '질문 원문 확인 못함',
};

/** 질문별 답변 — 질문(원문 인용)·답·근거·확인 표시. 문서 칸은 아래에서 고친다 */
export default function QaView({ data }: { data: QaDto }) {
  return (
    <Card>
      <h2 className="text-[16px] font-semibold">{data.kind === 'reply' ? '질문별 회신' : '요구 항목별 답변'}</h2>
      <p className="mt-1 text-[13px] text-slate-600">
        {data.kind === 'reply' ? '답은 담당자가 확인한 사실(F번호)·근거 자료로만 씁니다. 근거 없는 약속·다른 사람 정보는 표시합니다.' : '답마다 증빙을 대응시키고, 증빙 없는 주장·과거 수치 차이를 표시합니다.'}
      </p>
      <ol className="mt-3 space-y-3">
        {data.pairs.map((p) => (
          <li key={p.id} className="rounded-lg border border-[#DCE3EC] p-3 text-[14px]">
            <div className="font-medium">
              {p.id}. {p.question}
            </div>
            <p className={`mt-1 whitespace-pre-wrap ${p.answer ? 'text-slate-800' : 'text-red-700'}`}>{p.answer || '답변 없음 — 질문별로 빠짐없이 답해야 합니다'}</p>
            <div className="mt-1 text-[12px] text-slate-500">근거: {p.evidence.length ? p.evidence.map((e) => (e.id.startsWith('F') ? `담당자 확인 ${e.id}` : e.label)).join(', ') : '없음'}</div>
            {p.priorDiffs.map((d) => (
              <div key={d.label} className="text-[12px] text-slate-600">
                과거 수치 {d.label}: {d.prior} → {d.current}
                {d.reason ? ` (${d.reason})` : ' — 차이 근거 없음'}
              </div>
            ))}
            {p.flags.length > 0 && <div className="mt-1 text-[13px] text-amber-800">{p.flags.map((f) => FLAG[f] ?? f).join(', ')}</div>}
            <details className="mt-1">
              <summary className="cursor-pointer text-[13px] text-[#003087]">질문 원문</summary>
              <p className="mt-1 whitespace-pre-wrap text-[13px] text-slate-700">{p.quote || '(인용 없음)'}</p>
              <p className="text-[12px] text-slate-500">{p.sourceName ?? ''}</p>
            </details>
          </li>
        ))}
      </ol>
    </Card>
  );
}
