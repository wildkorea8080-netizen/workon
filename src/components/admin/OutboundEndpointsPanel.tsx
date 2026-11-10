'use client';

import { useCallback, useEffect, useState } from 'react';
import {
  OUTBOUND_MAX_ATTEMPTS, OUTBOUND_MAX_ENDPOINTS, OUTBOUND_NAME_MAX, OUTBOUND_REVOKE_REASON_MIN, OUTBOUND_STATUS_LABELS, OUTBOUND_URL_MAX, OUTBOUND_VERIFY_HINT,
  type OutboundDeliveryView, type OutboundEndpointView,
} from '@/lib/apps/outbound/spec';

const kst = (iso: string | null) => (iso ? new Date(iso).toLocaleString('ko-KR', { timeZone: 'Asia/Seoul', dateStyle: 'short', timeStyle: 'short' }) : '—');

/**
 * 앱 결과를 보낼 곳(0076) — 기관 전체 관리자가 https 주소를 승인해 두면 직원이 입력형 앱에서 골라, 실행을 마친 결과 글을 그 주소로 서명해 보낸다.
 * 기관 전체 관리자가 아니면 안내만 보인다. 보낸 결과 글은 이 화면에 보이지 않는다(상태·응답 코드만)
 */
export default function OutboundEndpointsPanel() {
  const [endpoints, setEndpoints] = useState<OutboundEndpointView[]>([]);
  const [deliveries, setDeliveries] = useState<OutboundDeliveryView[]>([]);
  const [denied, setDenied] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [name, setName] = useState('');
  const [url, setUrl] = useState('');
  const [busy, setBusy] = useState(false);
  const [created, setCreated] = useState<{ name: string; secret: string } | null>(null);

  const load = useCallback(async () => {
    try {
      const res = await fetch('/api/admin/outbound-endpoints');
      const body = await res.json().catch(() => null);
      if (res.status === 403) { setDenied(body?.error?.message ?? '기관 전체 관리자만 볼 수 있습니다.'); return; }
      if (!res.ok || !body?.ok) { setError(body?.error?.message ?? '보낼 곳 목록을 불러오지 못했습니다.'); return; }
      setError(null); setEndpoints(body.data.endpoints); setDeliveries(body.data.deliveries);
    } catch {
      setError('보낼 곳 목록을 불러오지 못했습니다.');
    }
  }, []);
  useEffect(() => { void load(); }, [load]);

  async function create() {
    if (busy || !name.trim() || !url.trim()) return;
    setBusy(true); setError(null); setCreated(null);
    try {
      const res = await fetch('/api/admin/outbound-endpoints', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name, url }) });
      const body = await res.json().catch(() => null);
      if (!res.ok || !body?.ok) setError(body?.error?.message ?? '보낼 곳을 만들지 못했습니다.');
      else { setCreated({ name: body.data.endpoint.name, secret: body.data.secret }); setName(''); setUrl(''); await load(); }
    } finally { setBusy(false); }
  }

  async function revoke(endpoint: OutboundEndpointView) {
    const reason = window.prompt(`'${endpoint.name}'을(를) 회수합니다. 이 곳으로 보낼 결과는 더 보내지 않고, 보내지 않은 기록도 그만둡니다. 되돌릴 수 없습니다.\n\n회수 사유(${OUTBOUND_REVOKE_REASON_MIN}자 이상):`);
    if (reason === null) return;
    setError(null);
    const res = await fetch(`/api/admin/outbound-endpoints/${encodeURIComponent(endpoint.id)}`, { method: 'DELETE', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ reason }) });
    const body = await res.json().catch(() => null);
    if (!res.ok || !body?.ok) setError(body?.error?.message ?? '보낼 곳을 회수하지 못했습니다.');
    else await load();
  }

  if (denied) {
    return <section className="rounded-xl border border-slate-200 bg-white p-5"><h2 className="font-semibold text-slate-900">앱 결과 보낼 곳</h2><p className="mt-2 text-sm text-slate-600">{denied}</p></section>;
  }
  const active = endpoints.filter((e) => !e.revokedAt);
  return (
    <section className="space-y-4 rounded-xl border border-slate-200 bg-white p-5">
      <div>
        <h2 className="font-semibold text-slate-900">앱 결과 보낼 곳</h2>
        <p className="mt-1 text-sm leading-6 text-slate-600">
          승인한 https 주소로 입력형 앱의 <strong>결과 글</strong>을 보냅니다(직원이 앱 빌더에서 보낼 곳을 고른 앱만, 끝까지 마친 실행만, 시험 판 실행은 빼고).
          입력값·중간 단계·직원 정보는 보내지 않습니다. 결과 글이 기관 밖으로 나가므로 받는 시스템을 확인한 뒤 등록하세요.
          보내기는 약 5분마다 이루어지고, 실패하면 {OUTBOUND_MAX_ATTEMPTS}번까지 다시 보냅니다. 기관에 {OUTBOUND_MAX_ENDPOINTS}곳까지, 내부망·사설 IP 주소는 받지 않습니다.
        </p>
      </div>
      <div className="grid gap-2 md:grid-cols-[1fr_2fr_auto]">
        <input aria-label="보낼 곳 이름" value={name} maxLength={OUTBOUND_NAME_MAX} onChange={(e) => setName(e.target.value)} placeholder="이름 — 예: 전자결재 연계" className="rounded-lg border border-slate-200 px-3 py-2 text-sm" />
        <input aria-label="보낼 주소" value={url} maxLength={OUTBOUND_URL_MAX} onChange={(e) => setUrl(e.target.value)} placeholder="https://example.go.kr/workon/receive" className="rounded-lg border border-slate-200 px-3 py-2 text-sm" />
        <button type="button" disabled={busy || !name.trim() || !url.trim() || active.length >= OUTBOUND_MAX_ENDPOINTS} onClick={() => void create()} className="rounded-lg bg-[#003087] px-4 py-2 text-sm font-semibold text-white disabled:opacity-40">{busy ? '만드는 중…' : '보낼 곳 만들기'}</button>
      </div>
      {created && (
        <div role="status" className="rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm leading-6">
          <p className="font-semibold">'{created.name}'의 서명 비밀값 — 지금 한 번만 보입니다. 받는 시스템에 넣어 두세요.</p>
          <code className="mt-1 block break-all rounded bg-white px-2 py-1 text-xs">{created.secret}</code>
          <p className="mt-1 text-xs text-slate-600">{OUTBOUND_VERIFY_HINT}</p>
        </div>
      )}
      {error && <p role="alert" className="text-sm text-red-700">{error}</p>}
      <table className="w-full text-left text-xs">
        <thead className="text-slate-500"><tr><th className="py-1 pr-2">이름</th><th className="pr-2">주소</th><th className="pr-2">비밀값 앞부분</th><th className="pr-2">만든 때</th><th className="pr-2">상태</th><th /></tr></thead>
        <tbody>{endpoints.map((e) => (
          <tr key={e.id} className="border-t border-slate-100 align-top">
            <td className="py-1 pr-2 font-medium">{e.name}</td>
            <td className="break-all pr-2">{e.url}</td>
            <td className="pr-2"><code>{e.secretPrefix}…</code></td>
            <td className="pr-2">{kst(e.createdAt)}{e.createdByName ? ` · ${e.createdByName}` : ''}</td>
            <td className="pr-2">{e.revokedAt ? <span className="text-slate-500">회수됨({kst(e.revokedAt)}) — {e.revokedReason}</span> : <span className="text-emerald-700">쓰는 중</span>}</td>
            <td>{!e.revokedAt && <button type="button" onClick={() => void revoke(e)} className="text-red-600 underline">회수</button>}</td>
          </tr>))}
          {!endpoints.length && <tr><td colSpan={6} className="py-2 text-slate-500">아직 보낼 곳이 없습니다.</td></tr>}
        </tbody>
      </table>
      <div>
        <h3 className="text-sm font-semibold text-slate-800">최근 보내기 {deliveries.length ? `(${deliveries.length}건)` : ''}</h3>
        <table className="mt-2 w-full text-left text-xs">
          <thead className="text-slate-500"><tr><th className="py-1 pr-2">넣은 때</th><th className="pr-2">앱</th><th className="pr-2">보낼 곳</th><th className="pr-2">상태</th><th className="pr-2">시도</th><th>마지막 응답</th></tr></thead>
          <tbody>{deliveries.map((d) => (
            <tr key={d.id} className="border-t border-slate-100 align-top">
              <td className="py-1 pr-2">{kst(d.createdAt)}</td>
              <td className="pr-2">{d.appName}</td>
              <td className="pr-2">{d.endpointName}</td>
              <td className={`pr-2 ${d.status === 'sent' ? 'text-emerald-700' : d.status === 'gave_up' ? 'text-red-700' : 'text-slate-700'}`}>{OUTBOUND_STATUS_LABELS[d.status]}{d.sentAt ? ` · ${kst(d.sentAt)}` : ''}{d.nextAttemptAt ? ` · 다음 ${kst(d.nextAttemptAt)}` : ''}</td>
              <td className="pr-2">{d.attempts}</td>
              <td>{d.lastStatus ?? '—'}{d.lastError ? ` · ${d.lastError}` : ''}</td>
            </tr>))}
            {!deliveries.length && <tr><td colSpan={6} className="py-2 text-slate-500">보낸 기록이 없습니다.</td></tr>}
          </tbody>
        </table>
      </div>
    </section>
  );
}
