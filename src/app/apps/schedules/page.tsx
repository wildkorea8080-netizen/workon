'use client';
import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import WorkShell, { Card, ErrorNote, PageTitle, StatusBadge } from '@/components/work/WorkShell';
import { api, formatDateTime } from '@/lib/work/client';
import { APP_MAX_SCHEDULES_PER_USER, scheduleBadge, type AppScheduleView } from '@/lib/apps/schedule-spec';

function Schedules() {
  const [items, setItems] = useState<AppScheduleView[]>([]); const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null); const [busy, setBusy] = useState<string | null>(null);
  const load = useCallback(async () => {
    setLoading(true); setError(null);
    const result = await api<AppScheduleView[]>('/api/apps/schedules');
    if (result.ok) setItems(result.data); else setError(result.error.message);
    setLoading(false);
  }, []);
  useEffect(() => { void load(); }, [load]);
  async function act(s: AppScheduleView, action: 'pause' | 'resume' | 'delete') {
    if (action === 'delete' && !window.confirm(`'${s.appName}' ${s.description} 예약을 지울까요? 지난 실행 결과는 앱 실행 기록에 남습니다.`)) return;
    setBusy(s.id); setError(null);
    const result = action === 'delete'
      ? await api<{ id: string }>(`/api/apps/schedules/${encodeURIComponent(s.id)}`, { method: 'DELETE' })
      : await api<AppScheduleView>(`/api/apps/schedules/${encodeURIComponent(s.id)}`, { method: 'PATCH', json: { action } });
    if (!result.ok) setError(result.error.message);
    else if (action === 'delete') setItems(previous => previous.filter(item => item.id !== s.id));
    else setItems(previous => previous.map(item => item.id === s.id ? result.data as AppScheduleView : item));
    setBusy(null);
  }
  return <div className="mx-auto max-w-6xl px-5 py-9 md:px-9">
    <PageTitle title="앱 예약" subtitle={`저장한 입력으로 입력형 앱을 정해진 시각(한국 시간)에 자동 실행합니다. 결과는 앱 실행 기록에 [예약] 제목으로 남습니다. 한 사람당 ${APP_MAX_SCHEDULES_PER_USER}개까지.`} action={<span className="flex gap-4"><Link href="/apps/webhooks" className="text-sm font-semibold text-ws-accent-text">앱 연동</Link><Link href="/apps" className="text-sm font-semibold text-ws-accent-text">업무 앱으로</Link></span>} />
    <ErrorNote message={error} />
    <div className="my-5 flex justify-end"><button type="button" disabled={loading} onClick={() => void load()} className="text-sm text-ws-accent-text disabled:opacity-40">새로고침</button></div>
    {loading ? <p role="status" className="py-10 text-center text-slate-500">예약을 불러오는 중…</p> : items.length ? <div className="space-y-4">{items.map(s => { const badge = scheduleBadge(s); return <Card key={s.id}>
      <div className="flex flex-wrap items-start justify-between gap-3"><div><p className="mb-2 text-xs font-medium text-ws-accent-text">{s.appName} · 앱 판 {s.appVersion}</p><h2 className="font-semibold">{s.description}</h2><p className="mt-2 text-xs text-slate-500">다음 실행 {s.status === 'active' ? formatDateTime(s.nextRunAt) : '—'} · 실행 {s.runCount}회{s.lastRunAt ? ` · 마지막 ${formatDateTime(s.lastRunAt)}` : ''}</p></div><StatusBadge label={badge.label} tone={badge.tone} /></div>
      {s.status === 'paused' && s.pausedReason && <p className="mt-3 rounded-lg bg-amber-50 p-3 text-xs leading-5 text-amber-900">{s.pausedReason}</p>}
      {s.overdue && <p className="mt-3 rounded-lg bg-red-50 p-3 text-xs leading-5 text-red-900">예정 시각이 1시간 넘게 지났는데 실행되지 않았습니다. 실행기가 멈춘 것일 수 있으니 기관 관리자에게 알려 주세요.</p>}
      {s.lastStatus === 'failed' && s.lastError && <p className="mt-3 text-xs leading-5 text-slate-600">마지막 실패 이유: {s.lastError}</p>}
      {s.documentCount > 0 && <p className="mt-3 text-xs text-slate-600">문서함 문서 {s.documentCount}개 — 실행 때마다 그 문서의 지금 판으로 읽습니다(어느 판을 썼는지는 실행 결과의 근거에 남습니다).</p>}
      <details className="mt-3 text-xs text-slate-600"><summary className="cursor-pointer">저장한 입력 보기</summary><dl className="mt-2 space-y-1">{Object.entries(s.inputs).map(([key, value]) => <div key={key} className="flex gap-2"><dt className="shrink-0 font-medium text-slate-500">{key}</dt><dd className="break-words whitespace-pre-wrap">{value || '(비어 있음)'}</dd></div>)}</dl></details>
      <div className="mt-5 flex flex-wrap gap-3">
        {s.adminPaused ? <span className="rounded-xl border border-red-200 bg-red-50 px-4 py-2 text-sm text-red-800">관리자가 멈춘 예약 — 다시 켜려면 기관 관리자에게 문의하세요</span> : s.status === 'active' ? <button type="button" disabled={busy === s.id} onClick={() => void act(s, 'pause')} className="rounded-xl border border-slate-200 px-4 py-2 text-sm font-semibold text-slate-700 disabled:opacity-40">멈추기</button> : <button type="button" disabled={busy === s.id} onClick={() => void act(s, 'resume')} className="rounded-xl bg-ws-accent px-4 py-2 text-sm font-semibold text-white disabled:opacity-40">다시 켜기</button>}
        <button type="button" disabled={busy === s.id} onClick={() => void act(s, 'delete')} className="rounded-xl border border-red-200 px-4 py-2 text-sm text-red-700 disabled:opacity-40">지우기</button>
        {s.lastConversationId && <Link href={`/chat?conv=${encodeURIComponent(s.lastConversationId)}`} className="rounded-xl border border-slate-200 px-4 py-2 text-sm text-ws-accent-text">마지막 결과 보기</Link>}
        <Link href={`/apps/history?agent=${encodeURIComponent(s.agentId)}`} className="rounded-xl border border-slate-200 px-4 py-2 text-sm text-slate-600">이 앱 실행 기록</Link>
        <Link href={`/apps/run?agent=${encodeURIComponent(s.agentId)}`} className="rounded-xl border border-slate-200 px-4 py-2 text-sm text-slate-600">앱 열기</Link>
      </div>
    </Card>; })}</div> : <Card><p className="text-sm text-slate-500">{error ? '예약을 확인하지 못했습니다. 새로고침으로 다시 시도해 주세요.' : '예약이 없습니다. 입력형 앱 실행 화면에서 입력을 채운 뒤 \'이 입력으로 예약 실행 걸기\'를 누르세요.'}</p></Card>}
  </div>;
}
export default function Page() { return <WorkShell><Schedules /></WorkShell>; }
