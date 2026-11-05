'use client';

import { useCallback, useEffect, useState } from 'react';
import { FEEDBACK_REASONS, type FeedbackReason, type FeedbackSummary as Summary } from '@/lib/message-feedback-spec';

type Data = Summary & { from: string; to: string };
const REASON_KEYS = Object.keys(FEEDBACK_REASONS) as FeedbackReason[];

/** 비서별 답변 평가 표(순수 렌더링) — 숫자·비서 이름만 */
export function FeedbackSummaryTable({ data }: { data: Data }) {
  if (!data.agents.length) return <p className="text-sm text-slate-500">이 기간에 남긴 답변 평가가 없습니다.</p>;
  return (
    <div className="space-y-2">
      <p className="text-sm text-slate-700">
        전체 도움됨 {data.total.up}건 · 아쉬움 {data.total.down}건{data.total.helpfulPercent !== null ? ` · 도움됨 비율 ${data.total.helpfulPercent}%` : ''}
        {data.truncated ? ' (평가가 많아 일부만 셌습니다)' : ''}
      </p>
      <div className="overflow-x-auto rounded-xl border border-slate-200 bg-white">
        <table className="min-w-full text-sm">
          <thead className="bg-slate-50 text-left text-xs text-slate-500">
            <tr>
              <th className="px-3 py-2">비서</th>
              <th className="px-3 py-2 text-right">도움됨</th>
              <th className="px-3 py-2 text-right">아쉬움</th>
              <th className="px-3 py-2 text-right">도움됨 비율</th>
              {REASON_KEYS.map((k) => <th key={k} className="px-3 py-2 text-right">{FEEDBACK_REASONS[k]}</th>)}
            </tr>
          </thead>
          <tbody>
            {data.agents.map((a, i) => (
              <tr key={`${a.agentId ?? a.agentName}-${i}`} className="border-t border-slate-100">
                <td className="px-3 py-2 text-slate-800">{a.agentName}</td>
                <td className="px-3 py-2 text-right">{a.up}</td>
                <td className="px-3 py-2 text-right">{a.down}</td>
                <td className="px-3 py-2 text-right">{a.helpfulPercent === null ? '—' : `${a.helpfulPercent}%`}</td>
                {REASON_KEYS.map((k) => <td key={k} className="px-3 py-2 text-right text-slate-600">{a.reasons[k] || ''}</td>)}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

/** 관리자 통계의 '답변 평가' — 기간(KST, 기본 최근 30일)을 골라 비서별로 본다 */
export default function FeedbackSummary() {
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [data, setData] = useState<Data | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const load = useCallback(async (f: string, t: string) => {
    setLoading(true);
    setError(null);
    const q = new URLSearchParams();
    if (f) q.set('from', f);
    if (t) q.set('to', t);
    try {
      const res = await fetch(`/api/admin/feedback-summary${q.size ? `?${q}` : ''}`);
      const body = (await res.json().catch(() => null)) as { ok?: boolean; data?: Data; error?: { message?: string } } | null;
      if (!res.ok || !body?.ok || !body.data) throw new Error(body?.error?.message ?? '답변 평가를 불러오지 못했습니다.');
      setData(body.data);
      setFrom(body.data.from);
      setTo(body.data.to);
    } catch (e) {
      setError(e instanceof Error ? e.message : '답변 평가를 불러오지 못했습니다.');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void load('', ''); }, [load]);

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-end gap-2 text-sm">
        <label className="text-xs text-slate-500">시작<input type="date" value={from} onChange={(e) => setFrom(e.target.value)} className="ml-1 rounded-lg border border-slate-200 px-2 py-1 text-sm" /></label>
        <label className="text-xs text-slate-500">끝<input type="date" value={to} onChange={(e) => setTo(e.target.value)} className="ml-1 rounded-lg border border-slate-200 px-2 py-1 text-sm" /></label>
        <button type="button" disabled={loading} onClick={() => void load(from, to)} className="rounded-lg border border-slate-200 px-3 py-1 text-sm text-[#003087] disabled:opacity-40">조회</button>
      </div>
      {error && <p role="alert" className="text-sm text-red-600">{error}</p>}
      {loading && !data ? <p role="status" className="text-sm text-slate-500">불러오는 중…</p> : data && <FeedbackSummaryTable data={data} />}
    </div>
  );
}
