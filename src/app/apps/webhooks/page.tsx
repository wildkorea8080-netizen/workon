'use client';
import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import WorkShell, { Card, ErrorNote, PageTitle, StatusBadge } from '@/components/work/WorkShell';
import { api, formatDateTime } from '@/lib/work/client';
import { APP_MAX_WEBHOOKS_PER_USER, WEBHOOK_DAILY_LIMIT, WEBHOOK_MIN_INTERVAL_SECONDS, WEBHOOK_ORG_DISABLED, type AppWebhookView } from '@/lib/apps/webhook-spec';

const STATE_LABEL: Record<AppWebhookView['state'], { label: string; tone: 'ok' | 'warn' | 'neutral' }> = {
  active: { label: '쓰는 중', tone: 'ok' }, expired: { label: '만료', tone: 'neutral' }, revoked: { label: '회수함', tone: 'neutral' },
};

function Webhooks() {
  const [items, setItems] = useState<AppWebhookView[]>([]); const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null); const [busy, setBusy] = useState<string | null>(null);
  const load = useCallback(async () => {
    setLoading(true); setError(null);
    const result = await api<AppWebhookView[]>('/api/apps/webhooks');
    if (result.ok) setItems(result.data); else setError(result.error.message);
    setLoading(false);
  }, []);
  useEffect(() => { void load(); }, [load]);
  async function revoke(w: AppWebhookView) {
    if (!window.confirm(`'${w.name}' 연동을 회수할까요? 이 토큰으로는 더 실행할 수 없고 되돌릴 수 없습니다.`)) return;
    setBusy(w.id); setError(null);
    const result = await api<AppWebhookView>(`/api/apps/webhooks/${encodeURIComponent(w.id)}`, { method: 'DELETE' });
    if (result.ok) setItems(previous => previous.map(item => item.id === w.id ? result.data : item)); else setError(result.error.message);
    setBusy(null);
  }
  return <div className="mx-auto max-w-6xl px-5 py-9 md:px-9">
    <PageTitle title="앱 연동" subtitle={`외부 시스템이 연동 토큰으로 입력형 앱을 내 권한으로 실행합니다. 결과는 앱 실행 기록에 [연동] 제목으로 남고 외부로는 상태만 갑니다. 같은 연동은 ${WEBHOOK_MIN_INTERVAL_SECONDS}초에 한 번·하루 ${WEBHOOK_DAILY_LIMIT}번, 쓸 수 있는 연동은 한 사람당 ${APP_MAX_WEBHOOKS_PER_USER}개.`} action={<Link href="/apps/schedules" className="text-sm font-semibold text-ws-accent-text">앱 예약으로</Link>} />
    <ErrorNote message={error} />
    <div className="my-5 flex justify-end"><button type="button" disabled={loading} onClick={() => void load()} className="text-sm text-ws-accent-text disabled:opacity-40">새로고침</button></div>
    {loading ? <p role="status" className="py-10 text-center text-slate-500">연동을 불러오는 중…</p> : items.length ? <div className="space-y-4">{items.map(w => { const badge = STATE_LABEL[w.state]; return <Card key={w.id}>
      <div className="flex flex-wrap items-start justify-between gap-3"><div><p className="mb-2 text-xs font-medium text-ws-accent-text">{w.appName} · 앱 판 {w.appVersion}</p><h2 className="font-semibold">{w.name}</h2><p className="mt-2 text-xs text-slate-500">토큰 <code>{w.tokenPrefix}…</code> · {formatDateTime(w.expiresAt)}까지 · 실행 {w.useCount}회{w.lastUsedAt ? ` · 마지막 ${formatDateTime(w.lastUsedAt)}` : ''}</p></div><StatusBadge label={badge.label} tone={badge.tone} /></div>
      {w.blockedByOrg && <p className="mt-3 rounded-lg bg-red-50 p-3 text-xs leading-5 text-red-900">{WEBHOOK_ORG_DISABLED}</p>}
      {w.state === 'revoked' && w.revokedReason && <p className="mt-3 rounded-lg bg-amber-50 p-3 text-xs leading-5 text-amber-900">{w.revokedReason}</p>}
      {w.documentCount > 0 && <p className="mt-3 text-xs text-slate-600">문서함 문서 {w.documentCount}개 — 호출마다 그 문서의 지금 판으로 읽습니다.</p>}
      {w.lastStatus === 'failed' && w.lastError && <p className="mt-3 text-xs leading-5 text-slate-600">마지막 실패 이유: {w.lastError}</p>}
      <div className="mt-5 flex flex-wrap gap-3">
        {w.state === 'active' && <button type="button" disabled={busy === w.id} onClick={() => void revoke(w)} className="rounded-xl border border-red-200 px-4 py-2 text-sm text-red-700 disabled:opacity-40">회수</button>}
        {w.lastConversationId && <Link href={`/chat?conv=${encodeURIComponent(w.lastConversationId)}`} className="rounded-xl border border-slate-200 px-4 py-2 text-sm text-ws-accent-text">마지막 결과 보기</Link>}
        <Link href={`/apps/history?agent=${encodeURIComponent(w.agentId)}`} className="rounded-xl border border-slate-200 px-4 py-2 text-sm text-slate-600">이 앱 실행 기록</Link>
      </div>
    </Card>; })}</div> : <Card><p className="text-sm text-slate-500">{error ? '연동을 확인하지 못했습니다. 새로고침으로 다시 시도해 주세요.' : '연동이 없습니다. 입력형 앱 실행 화면에서 \'외부 시스템 연동(Webhook) 만들기\'를 누르세요.'}</p></Card>}
  </div>;
}
export default function Page() { return <WorkShell><Webhooks /></WorkShell>; }
