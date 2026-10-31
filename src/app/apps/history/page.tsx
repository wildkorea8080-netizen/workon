'use client';
import { Suspense, useCallback, useEffect, useRef, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import Link from 'next/link';
import WorkShell, { Card, ErrorNote, PageTitle, StatusBadge } from '@/components/work/WorkShell';
import AppStepResults from '@/components/apps/AppStepResults';
import { api } from '@/lib/work/client';
import type { Agent } from '@/lib/db';
import type { AppHistoryItem, AppHistoryStatus } from '@/lib/apps/history';
type PageData = { items: AppHistoryItem[]; nextCursor: string | null };
const labels: Record<AppHistoryStatus, string> = { saved: '응답 저장됨', interrupted: '중단됨', no_response: '응답 기록 없음', uncertain: '상태 확인 필요' };
function History() {
  const agentId = useSearchParams().get('agent') ?? ''; const router = useRouter();
  const [items, setItems] = useState<AppHistoryItem[]>([]); const [cursor, setCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(true); const [more, setMore] = useState(false); const [error, setError] = useState<string | null>(null);
  const [agents, setAgents] = useState<Agent[]>([]); const [query, setQuery] = useState(''); const [status, setStatus] = useState<AppHistoryStatus | 'all'>('all');
  const sequence = useRef(0); const controller = useRef<AbortController | null>(null); const pending = useRef(false);
  const load = useCallback(async (next?: string) => {
    if (next && pending.current) return;
    const token = ++sequence.current; controller.current?.abort(); const request = new AbortController(); controller.current = request;
    pending.current = true; setLoading(!next); setMore(Boolean(next)); setError(null);
    if (!next) { setItems([]); setCursor(null); }
    const params = new URLSearchParams(); if (agentId) params.set('agent', agentId); if (next) params.set('cursor', next);
    const result = await api<PageData>(`/api/apps/history?${params}`, { signal: request.signal });
    if (sequence.current !== token) return;
    if (result.ok) { setItems(previous => next ? [...new Map([...previous, ...result.data.items].map(item => [item.id, item])).values()] : result.data.items); setCursor(result.data.nextCursor); }
    else if (!request.signal.aborted) setError(result.error.message);
    setLoading(false); setMore(false); pending.current = false;
  }, [agentId]);
  useEffect(() => { void load(); return () => { sequence.current++; controller.current?.abort(); pending.current = false; }; }, [load]);
  useEffect(() => {
    let active = true;
    void Promise.all([api<Agent[]>('/api/agents'), api<Agent[]>('/api/agents?personal=true')]).then(results => {
      if (active) setAgents([...new Map(results.flatMap(r => r.ok ? r.data.filter(a => a.app_definition) : []).map(a => [a.id, a])).values()]);
    });
    return () => { active = false; };
  }, []);
  const words = query.trim().toLocaleLowerCase();
  const visible = items.filter(item => (status === 'all' || item.status === status) && `${item.title} ${item.appName} ${item.preview}`.toLocaleLowerCase().includes(words));
  return <div className="mx-auto max-w-6xl px-5 py-9 md:px-9"><PageTitle title="앱 실행 기록" subtitle="현재 사용할 수 있는 입력형 앱의 내 대화입니다. 생성 시각 순서로 최근 저장된 응답을 확인합니다." action={<Link href="/apps" className="text-sm font-semibold text-[#087581]">업무 앱으로</Link>} /><ErrorNote message={error} />
    <div className="my-6 grid gap-4 rounded-2xl border border-slate-200 bg-white p-5 md:grid-cols-3"><label className="text-sm">앱<select className="mt-2 w-full rounded-xl border border-slate-200 px-3 py-2.5" value={agentId} onChange={e => { const p = new URLSearchParams(); if (e.target.value) p.set('agent', e.target.value); router.replace(`/apps/history${p.size ? `?${p}` : ''}`); }}><option value="">전체 입력형 앱</option>{agentId && !agents.some(a => a.id === agentId) && <option value={agentId}>선택한 앱</option>}{agents.map(agent => <option key={agent.id} value={agent.id}>{agent.name}</option>)}</select></label><label className="text-sm">기록 상태<select className="mt-2 w-full rounded-xl border border-slate-200 px-3 py-2.5" value={status} onChange={e => setStatus(e.target.value as typeof status)}><option value="all">전체 상태</option>{Object.entries(labels).map(([value, text]) => <option key={value} value={value}>{text}</option>)}</select></label><label className="text-sm">불러온 기록에서 검색<input type="search" value={query} maxLength={100} onChange={e => setQuery(e.target.value)} placeholder="제목·앱 이름·최근 응답" className="mt-2 w-full rounded-xl border border-slate-200 px-3 py-2.5" /></label></div>
    <div className="mb-5 flex flex-wrap items-center justify-between gap-3"><p aria-live="polite" className="text-xs text-slate-500">불러온 {items.length}건 중 {visible.length}건 · 상태와 검색은 불러온 기록에 적용됩니다.</p><button type="button" disabled={loading || more} onClick={() => void load()} className="text-sm text-[#087581] disabled:opacity-40">새로고침</button></div>
    {loading ? <p role="status" className="py-10 text-center text-slate-500">기록을 불러오는 중…</p> : visible.length ? <div className="space-y-4">{visible.map(item => <Card key={item.id}><div className="flex flex-wrap items-start justify-between gap-3"><div><p className="mb-2 text-xs font-medium text-[#087581]">{item.appName}{item.version ? ` · 실행 버전 ${item.version}` : ''}</p><h2 className="font-semibold">{item.title}</h2><p className="mt-2 text-xs text-slate-400">{new Date(item.createdAt).toLocaleString('ko-KR', { timeZone: 'Asia/Seoul' })}</p></div><StatusBadge label={labels[item.status]} tone={item.status === 'interrupted' ? 'warn' : item.status === 'saved' ? 'ok' : 'neutral'} /></div><p className="mt-4 line-clamp-2 break-words text-sm leading-6 text-slate-600">{item.preview || '저장된 응답이 없습니다. 실제 실행 중인지 이 기록만으로 판단할 수 없습니다.'}</p><AppStepResults steps={item.steps} /><div className="mt-5 flex flex-wrap gap-3"><Link href={`/chat?conv=${encodeURIComponent(item.id)}`} className="rounded-xl border border-slate-200 px-4 py-2 text-sm font-semibold text-[#087581]">대화·결과 보기</Link><Link href={`/apps/run?agent=${encodeURIComponent(item.agentId)}`} className="rounded-xl border border-slate-200 px-4 py-2 text-sm text-slate-600">새로 실행</Link>{item.canResume && item.messageId && <Link href={`/apps/run?agent=${encodeURIComponent(item.agentId)}&from=${encodeURIComponent(item.id)}&resume=${encodeURIComponent(item.messageId)}`} className="rounded-xl bg-[#087f8c] px-4 py-2 text-sm font-semibold text-white">완료된 단계부터 이어서</Link>}</div></Card>)}</div> : <Card><p className="text-sm text-slate-500">{error ? '기록을 확인하지 못했습니다. 새로고침으로 다시 시도해 주세요.' : items.length ? '불러온 기록 중 조건에 맞는 항목이 없습니다. 필터를 바꾸거나 다음 기록을 불러와 주세요.' : cursor ? '이번 목록에 표시할 기록이 없습니다. 다음 기록을 불러와 주세요.' : '표시할 앱 기록이 없습니다. 업무 앱에서 입력형 앱을 실행해 보세요.'}</p></Card>}
    {cursor && !loading && <button type="button" disabled={more} onClick={() => void load(cursor)} className="mt-6 w-full rounded-xl border border-slate-200 bg-white py-3 text-sm text-[#087581] disabled:opacity-40">{more ? '불러오는 중…' : '다음 기록 불러오기'}</button>}
  </div>;
}
export default function Page() { return <WorkShell><Suspense fallback={<p role="status">불러오는 중…</p>}><History /></Suspense></WorkShell>; }
