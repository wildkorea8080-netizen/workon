'use client';

import { useCallback, useEffect, useState } from 'react';
import { OUTBOUND_STATUS_LABELS, type OutboundMyDeliveryView } from '@/lib/apps/outbound/spec';

const kst = (iso: string) => new Date(iso).toLocaleString('ko-KR', { timeZone: 'Asia/Seoul', dateStyle: 'short', timeStyle: 'short' });

/**
 * 보낸 결과(0080) — 이 앱의 결과를 외부 시스템으로 보낸 기록(내 실행만): 상태·받는 쪽 접수 번호·받는 쪽 화면 링크.
 * 기록이 없으면 아무것도 그리지 않는다. `refreshKey`가 바뀌면(방금 실행을 마침) 다시 읽는다
 */
export default function OutboundDeliveriesPanel({ agentId, refreshKey }: { agentId: string; refreshKey?: string | null }) {
  const [items, setItems] = useState<OutboundMyDeliveryView[]>([]);
  const [error, setError] = useState<string | null>(null);
  const load = useCallback(async () => {
    try {
      const res = await fetch(`/api/apps/outbound-deliveries?agent=${encodeURIComponent(agentId)}`);
      const body = await res.json().catch(() => null);
      if (!res.ok || !body?.ok) { setError(body?.error?.message ?? '보낸 결과를 불러오지 못했습니다.'); return; }
      setError(null); setItems(body.data);
    } catch { setError('보낸 결과를 불러오지 못했습니다.'); }
  }, [agentId]);
  useEffect(() => { void load(); }, [load, refreshKey]);
  // 보내는 중·차례를 기다리는 기록이 있으면 1분마다 다시 읽는다
  useEffect(() => {
    if (!items.some((d) => d.status === 'pending' || d.status === 'sending')) return;
    const timer = setTimeout(() => void load(), 60_000);
    return () => clearTimeout(timer);
  }, [items, load]);

  if (!items.length && !error) return null;
  return (
    <section aria-label="보낸 결과" className="mt-6 space-y-2 rounded-xl border border-slate-200 p-4">
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-semibold text-slate-800">보낸 결과(최근 {items.length}건)</h3>
        <button type="button" onClick={() => void load()} className="text-xs text-ws-accent-text underline">새로고침</button>
      </div>
      <p className="text-xs leading-5 text-slate-500">이 앱의 결과를 외부 시스템으로 보낸 기록입니다(내 실행만). 받는 쪽이 접수 번호를 돌려주면 함께 보입니다.</p>
      {error && <p role="alert" className="text-xs text-red-700">{error}</p>}
      <ul className="space-y-1.5 text-xs">
        {items.map((d) => (
          <li key={d.id} className="rounded-lg border border-slate-100 p-2">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <span className="font-medium text-slate-800">{d.endpointName} · 실행 {kst(d.createdAt)}</span>
              <span className={d.status === 'sent' ? 'text-emerald-700' : d.status === 'gave_up' ? 'text-red-700' : 'text-slate-600'}>
                {OUTBOUND_STATUS_LABELS[d.status]}{d.sentAt ? ` · ${kst(d.sentAt)}` : ''}{d.nextAttemptAt ? ` · 다음 시도 ${kst(d.nextAttemptAt)}` : ''}
              </span>
            </div>
            {(d.receiptRef || d.receiptUrl) && (
              <p className="mt-1 text-slate-700">
                접수 번호 <strong>{d.receiptRef ?? '—'}</strong>
                {d.receiptUrl && <> · <a href={d.receiptUrl} target="_blank" rel="noopener noreferrer" className="text-ws-accent-text underline">받는 쪽에서 보기</a></>}
              </p>
            )}
            {d.lastError && d.status !== 'sent' && <p className="mt-1 text-slate-500">{d.lastError}</p>}
          </li>
        ))}
      </ul>
    </section>
  );
}
