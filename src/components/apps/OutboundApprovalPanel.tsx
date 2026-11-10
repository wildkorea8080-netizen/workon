'use client';

import Link from 'next/link';
import { useCallback, useEffect, useState } from 'react';
import { OUTBOUND_APPROVAL_DAYS, type OutboundApprovalView, type OutboundDecision } from '@/lib/apps/outbound/spec';

const kst = (iso: string) => new Date(iso).toLocaleString('ko-KR', { timeZone: 'Asia/Seoul', dateStyle: 'short', timeStyle: 'short' });

/**
 * 보내기 전 확인할 결과(0078) — 이 앱의 보낼 곳이 '보내기 전 확인'이면, 실행을 마친 결과(손 실행·예약·연동·일괄 실행)가
 * 여기 쌓이고 직원이 결과 글을 본 뒤 '보내기'를 눌러야 기관 밖으로 나간다. 확인할 결과가 없으면 아무것도 그리지 않는다.
 * `refreshKey`가 바뀌면(방금 실행을 마침) 다시 읽는다
 */
export default function OutboundApprovalPanel({ agentId, refreshKey }: { agentId: string; refreshKey?: string | null }) {
  const [items, setItems] = useState<OutboundApprovalView[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const res = await fetch(`/api/apps/outbound-approvals?agent=${encodeURIComponent(agentId)}`);
      const body = await res.json().catch(() => null);
      if (!res.ok || !body?.ok) { setError(body?.error?.message ?? '확인할 결과를 불러오지 못했습니다.'); return; }
      setError(null); setItems(body.data);
    } catch {
      setError('확인할 결과를 불러오지 못했습니다.');
    }
  }, [agentId]);
  useEffect(() => { void load(); }, [load, refreshKey]);

  async function decide(item: OutboundApprovalView, decision: OutboundDecision) {
    if (busy) return;
    if (decision === 'approve' && !window.confirm(`이 결과 글을 '${item.endpointName}'(으)로 보냅니다. 기관 밖 시스템으로 나가며 되돌릴 수 없습니다. 내용을 확인하셨나요?`)) return;
    setBusy(item.id); setError(null);
    try {
      const res = await fetch(`/api/apps/outbound-approvals/${encodeURIComponent(item.id)}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ decision }) });
      const body = await res.json().catch(() => null);
      if (!res.ok || !body?.ok) setError(body?.error?.message ?? '정하지 못했습니다.');
      await load();
    } finally { setBusy(null); }
  }

  if (!items.length && !error) return null;
  return (
    <section aria-label="보내기 전 확인할 결과" className="mt-6 space-y-3 rounded-xl border border-amber-200 bg-amber-50 p-4">
      <div>
        <h3 className="text-sm font-semibold text-amber-900">보내기 전 확인할 결과 {items.length ? `(${items.length}건)` : ''}</h3>
        <p className="mt-1 text-xs leading-5 text-amber-900">이 앱의 결과를 받을 외부 시스템은 보내기 전에 실행한 사람의 확인을 받습니다. 내용을 보고 <strong>보내기</strong>를 눌러야 약 5분 안에 보냅니다. {OUTBOUND_APPROVAL_DAYS}일 안에 정하지 않으면 보내지 않습니다.</p>
      </div>
      {error && <p role="alert" className="text-xs text-red-700">{error}</p>}
      <ul className="space-y-3">
        {items.map((item) => (
          <li key={item.id} className="rounded-lg border border-amber-100 bg-white p-3 text-xs">
            <p className="font-medium text-slate-800">{item.endpointName}(으)로 보낼 결과 · 실행 {kst(item.createdAt)} · {kst(item.expiresAt)}까지</p>
            <div className="mt-2 max-h-48 overflow-y-auto whitespace-pre-wrap break-words rounded bg-slate-50 p-2 leading-5 text-slate-700">{item.preview || '(결과 글을 찾지 못했습니다)'}{item.truncated ? '…' : ''}</div>
            <div className="mt-2 flex flex-wrap items-center gap-3">
              <button type="button" disabled={busy !== null || !item.preview} onClick={() => void decide(item, 'approve')} className="rounded-lg bg-ws-accent px-3 py-1.5 font-semibold text-white disabled:opacity-40">{busy === item.id ? '처리 중…' : '보내기'}</button>
              <button type="button" disabled={busy !== null} onClick={() => void decide(item, 'reject')} className="rounded-lg border border-slate-200 px-3 py-1.5 text-slate-700 disabled:opacity-40">보내지 않기</button>
              {item.conversationId && <Link href={`/chat?conv=${encodeURIComponent(item.conversationId)}`} className="text-ws-accent-text underline">{item.truncated ? '전체 결과·근거 보기' : '대화에서 근거 보기'}</Link>}
            </div>
          </li>
        ))}
      </ul>
    </section>
  );
}
