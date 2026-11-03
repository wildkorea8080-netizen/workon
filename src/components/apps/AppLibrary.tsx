'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { useSession } from 'next-auth/react';
import type { Agent } from '@/lib/db';
import type { WorkflowSummaryDto } from '@/components/work/types';
import { FEATURED_WORKFLOWS } from '@/lib/apps/home';
import { workLaunchLinks } from '@/lib/apps/work-launch';
import CreateAgentModal from '@/components/chat/CreateAgentModal';
import { Card, ErrorNote, PageTitle, StatusBadge } from '@/components/work/WorkShell';
import { api } from '@/lib/work/client';
import WorkspaceIcon, { workflowIcon } from '@/components/work/WorkspaceIcon';
import { appEntries, filterApps, favoriteAppIds, APP_KIND_LABELS, APP_SCOPE_LABELS, type AppKind, type AppScope } from '@/lib/apps/catalog';

type Favorites = { agentIds: string[]; workflowKeys: string[] };

export default function AppLibrary({ home = false }: { home?: boolean }) {
  const { data: session } = useSession();
  const [agents, setAgents] = useState<Agent[]>([]);
  const [workflows, setWorkflows] = useState<WorkflowSummaryDto[]>([]);
  const [newTasksEnabled, setNewTasksEnabled] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const [kind, setKind] = useState<AppKind | 'all'>(home ? 'workflow' : 'all');
  const [scope, setScope] = useState<AppScope | 'all'>('all');
  const [creating, setCreating] = useState(false);
  const [category, setCategory] = useState('all');
  const [favorites, setFavorites] = useState<Set<string>>(new Set());
  const [favoritesOnly, setFavoritesOnly] = useState(false);
  const [favoritesReady, setFavoritesReady] = useState(false);
  const [favoriteError, setFavoriteError] = useState<string | null>(null);
  const [savingFavorite, setSavingFavorite] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setLoading(true);
    const [shared, personal, work, saved] = await Promise.all([
      api<Agent[]>('/api/agents'), api<Agent[]>('/api/agents?personal=true'),
      api<{ workflows: WorkflowSummaryDto[]; settings: { newTasksEnabled: boolean } }>('/api/workflows'),
      api<Favorites>('/api/apps/favorites'),
    ]);
    setAgents([...(shared.ok ? shared.data : []), ...(personal.ok ? personal.data : [])]);
    setWorkflows(work.ok ? work.data.workflows : []);
    setNewTasksEnabled(work.ok && work.data.settings.newTasksEnabled);
    setFavoritesReady(saved.ok);
    if (saved.ok) setFavorites(favoriteAppIds(saved.data));
    setFavoriteError(saved.ok ? null : '즐겨찾기를 불러오지 못했습니다. 앱은 계속 사용할 수 있습니다.');
    const failed = [shared, personal, work].filter((r) => !r.ok);
    setError(failed.length ? '일부 앱을 불러오지 못했습니다. 다시 불러오기를 눌러 주세요.' : null);
    setLoading(false);
  }, []);

  useEffect(() => { void refresh(); }, [refresh]);
  const entries = useMemo(() => appEntries(agents, workflows, newTasksEnabled), [agents, workflows, newTasksEnabled]);
  const featured = FEATURED_WORKFLOWS.map((key) => entries.find((entry) => entry.id === `workflow:${key}`)).filter((entry): entry is (typeof entries)[number] => Boolean(entry));
  const categories = useMemo(() => [...new Set(entries.map((entry) => entry.category))].sort((a, b) => a.localeCompare(b, 'ko')), [entries]);
  const visible = useMemo(() => filterApps(entries, { query, kind, scope, category, favorites: favoritesOnly ? favorites : undefined }), [entries, query, kind, scope, category, favoritesOnly, favorites]);
  async function toggleFavorite(appId: string) {
    if (savingFavorite || !favoritesReady) return;
    setSavingFavorite(appId);
    const result = await api<Favorites>('/api/apps/favorites', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ appId, favorite: !favorites.has(appId) }) });
    if (result.ok) { setFavorites(favoriteAppIds(result.data)); setFavoriteError(null); }
    else setFavoriteError(result.error.message);
    setSavingFavorite(null);
  }

  return (
    <div className="app-library mx-auto max-w-[1320px] px-5 py-8 md:px-10 md:py-10">
      <p className="mb-3 text-[11px] font-bold tracking-[.18em] text-[#467b82]">{home ? 'YOUR DAILY WORKSPACE' : 'EXPLORE WORK APPS'}</p>
      <div className="mb-4 flex flex-wrap justify-end gap-3"><Link href="/apps/history" className="rounded-xl border border-slate-200 bg-white px-4 py-2.5 text-sm font-semibold text-[#087581]">앱 실행 기록</Link><Link href="/apps/schedules" className="rounded-xl border border-slate-200 bg-white px-4 py-2.5 text-sm font-semibold text-[#087581]">앱 예약</Link><Link href="/apps/builder" className="rounded-xl bg-[#087f8c] px-4 py-2.5 text-sm font-semibold text-white">+ 입력형 앱 만들기</Link></div>
      <PageTitle title={home ? '오늘 어떤 업무를 처리할까요?' : '업무 앱'} subtitle={home ? '자료를 넣고, 초안을 만들고, 근거를 검토해 결과 파일로 받으세요.' : '질문에 답하는 비서와 파일을 만드는 업무를 한곳에서 찾아보세요.'} action={home ? <Link href="/tasks" className="rounded-[10px] border border-[#003087] bg-white px-5 py-3 text-[15px] font-semibold text-[#003087]">내 작업 이어서 하기</Link> :
        <button type="button" onClick={() => setCreating(true)} className="rounded-[10px] bg-[#003087] px-5 py-3 text-[15px] font-semibold text-white hover:bg-[#002070]">비서 만들기</button>
      } />
      {home && <section aria-label="문서 업무 바로 시작" className="workspace-hero mb-9 overflow-hidden rounded-3xl border border-[#d6ebec] p-6 md:p-8">
        <div className="flex flex-wrap items-start justify-between gap-5">
          <div><span className="inline-flex items-center gap-1.5 rounded-full bg-white/80 px-3 py-1 text-xs font-semibold text-[#087581]"><WorkspaceIcon name="spark" className="!h-3.5 !w-3.5" />문서 업무 바로 시작</span>
          <h2 className="mt-4 text-[23px] font-bold tracking-tight text-[#173c44]">반복하는 업무는 줄이고,<br className="sm:hidden" /> 중요한 일에 집중하세요.</h2>
          <p className="mt-2 text-sm leading-6 text-[#55747b]">자료 준비부터 초안 작성까지, 업무에 맞는 앱으로 시작하세요.</p></div>
          <Link href="/chat" className="flex items-center gap-2 rounded-xl border border-white bg-white/80 px-4 py-3 text-sm font-semibold text-[#087581] hover:bg-white"><WorkspaceIcon name="chat" />AI 비서와 대화하기<WorkspaceIcon name="arrow" className="!h-4 !w-4" /></Link>
        </div>
        {loading ? <p role="status" className="mt-5 text-sm text-slate-500">사용 가능한 앱을 확인하는 중…</p> : <div className="mt-7 grid gap-3 sm:grid-cols-2 xl:grid-cols-5">{featured.map((entry, index) => <div key={entry.id} className={`featured-app app-tone-${index} flex flex-col rounded-2xl border border-white bg-white/90 p-4`}><span className="app-icon mb-4 flex h-10 w-10 items-center justify-center rounded-xl"><WorkspaceIcon name={workflowIcon(entry.id)} /></span><h3 className="text-sm font-semibold text-slate-800">{entry.name}</h3><p className="mt-2 line-clamp-2 text-xs leading-5 text-slate-500">{entry.description}</p>{entry.href ? <Link href={entry.href} className="mt-auto flex items-center justify-between pt-5 text-xs font-semibold text-[#087581]">시작하기<WorkspaceIcon name="arrow" className="!h-4 !w-4" /></Link> : <p className="mt-auto pt-4 text-xs leading-5 text-slate-500">{entry.unavailableReason}</p>}</div>)}</div>}
        {!loading && featured.length === 0 && <p className="mt-5 text-sm text-slate-500">현재 사용할 수 있는 문서 앱은 아래 목록에서 확인해 주세요.</p>}
      </section>}
      <ErrorNote message={error} />
      <ErrorNote message={favoriteError} />
      {favoriteError && !error && <button type="button" disabled={loading || Boolean(savingFavorite)} onClick={() => void refresh()} className="my-3 text-sm text-[#087581] underline disabled:opacity-50">즐겨찾기 다시 불러오기</button>}
      {error && <button type="button" onClick={() => void refresh()} disabled={loading} className="my-3 text-sm text-[#003087] underline disabled:opacity-50">다시 불러오기</button>}
      <div className="mb-5 flex flex-wrap items-center justify-between gap-3"><div><h2 className="text-lg font-bold tracking-tight">{home ? '나에게 필요한 업무 앱' : '앱 라이브러리'}</h2><p className="mt-1 text-sm text-slate-500">업무에 맞는 앱을 찾아 바로 시작하세요.</p></div><span className="rounded-full border border-slate-200 bg-white px-3 py-1 text-xs text-slate-500">{loading ? '불러오는 중' : `${entries.length}개의 앱`}</span></div>
      <div className="mb-6 grid gap-4 rounded-2xl border border-[#E7E9F1] bg-white p-4 sm:grid-cols-[1fr_150px_150px]">
        <div>
          <label htmlFor="apps-search" className="mb-1 block text-sm font-medium">앱 검색</label>
          <div className="relative"><WorkspaceIcon name="search" className="pointer-events-none absolute left-3 top-3 text-slate-400" /><input id="apps-search" type="search" value={query} onChange={(e) => setQuery(e.target.value)} placeholder="어떤 업무를 도와드릴까요?" className="w-full rounded-xl border border-[#E7E9F1] bg-[#FAFBFD] py-2.5 pl-10 pr-3 text-[14px] focus:border-[#16818c] focus:outline-none focus:ring-2 focus:ring-[#16818c]/20" /></div>
        </div>
        <div>
          <label htmlFor="apps-kind" className="mb-1 block text-sm font-medium">사용 방식</label>
          <select id="apps-kind" value={kind} onChange={(e) => setKind(e.target.value as AppKind | 'all')} className="w-full rounded-lg border border-slate-300 px-3 py-2.5 text-[15px]">
            <option value="all">전체 방식</option>
            {Object.entries(APP_KIND_LABELS).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
          </select>
        </div>
        <div>
          <label htmlFor="apps-scope" className="mb-1 block text-sm font-medium">제공 범위</label>
          <select id="apps-scope" value={scope} onChange={(e) => setScope(e.target.value as AppScope | 'all')} className="w-full rounded-lg border border-slate-300 px-3 py-2.5 text-[15px]">
            <option value="all">전체 범위</option>
            {Object.entries(APP_SCOPE_LABELS).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
          </select>
        </div>
      </div>
      <div className="mb-5 flex flex-wrap gap-2" role="group" aria-label="앱 사용 방식 빠른 선택">{([['all', '전체 앱'], ['workflow', '문서·업무 자동화'], ['form', '입력형 앱'], ['chat', 'AI 비서'], ['link', '외부 연결']] as const).map(([value, label]) => <button key={value} type="button" aria-pressed={kind === value} onClick={() => setKind(value)} className={`rounded-full border px-4 py-2 text-xs font-medium transition-colors ${kind === value ? 'border-[#087f8c] bg-[#087f8c] text-white' : 'border-[#E5E7EF] bg-white text-slate-500 hover:border-[#8ebfc4]'}`}>{label}</button>)}</div>
      <div className="mb-6 flex flex-wrap items-center gap-3"><button type="button" aria-pressed={favoritesOnly} disabled={!favoritesReady} onClick={() => { setFavoritesOnly((value) => !value); setKind('all'); }} className={`inline-flex items-center gap-2 rounded-xl border px-4 py-2 text-sm disabled:opacity-50 ${favoritesOnly ? 'border-[#087f8c] bg-[#E7F5F5] text-[#087581]' : 'border-slate-200 bg-white text-slate-600'}`}><WorkspaceIcon name="star" className="!h-4 !w-4" />즐겨찾기</button><label htmlFor="apps-category" className="text-sm text-slate-500">업무 분야</label><select id="apps-category" value={category} onChange={(event) => setCategory(event.target.value)} className="max-w-full rounded-xl border border-slate-200 bg-white px-3 py-2 text-sm"><option value="all">전체 분야</option>{categories.map((value) => <option key={value} value={value}>{value}</option>)}</select>{(query || category !== 'all' || scope !== 'all' || favoritesOnly || kind !== 'all') && <button type="button" onClick={() => { setQuery(''); setCategory('all'); setScope('all'); setKind('all'); setFavoritesOnly(false); }} className="text-xs text-slate-500 underline">필터 초기화</button>}</div>
      {loading ? <p role="status" className="py-12 text-center text-slate-500">앱을 불러오는 중…</p> : <>
        <p aria-live="polite" className="mb-3 text-sm text-slate-500">{visible.length}개 앱</p>
        {visible.length === 0 ? <Card><p className="text-slate-600">{favoritesOnly ? '조건에 맞는 즐겨찾기가 없습니다. 전체 앱에서 별 버튼으로 자주 쓰는 앱을 등록해 보세요.' : entries.length ? '조건에 맞는 앱이 없습니다. 검색어나 필터를 바꿔 보세요.' : error ? '앱 목록을 확인할 수 없습니다. 다시 불러와 주세요.' : '아직 사용할 앱이 없습니다. 내 업무에 맞는 비서를 만들어 보세요.'}</p></Card> :
          <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">{visible.map((entry, index) => <Card key={entry.id} className={`app-tile app-tone-${index % 5} flex h-full flex-col`}>
            <div className="mb-5 flex items-start justify-between gap-2"><span className="app-icon flex h-12 w-12 items-center justify-center rounded-2xl">{entry.kind === 'workflow' ? <WorkspaceIcon name={workflowIcon(entry.id)} className="!h-6 !w-6" /> : <span aria-hidden="true" className="text-xl">{entry.icon}</span>}</span><div className="flex items-center gap-2"><StatusBadge label={APP_SCOPE_LABELS[entry.scope]} /><button type="button" aria-label={`${entry.name} 즐겨찾기 ${favorites.has(entry.id) ? '해제' : '추가'}`} aria-pressed={favorites.has(entry.id)} disabled={!favoritesReady || Boolean(savingFavorite)} onClick={() => void toggleFavorite(entry.id)} className={`rounded-lg p-2 disabled:opacity-40 ${favorites.has(entry.id) ? 'bg-amber-50 text-amber-600' : 'text-slate-400 hover:bg-slate-50 hover:text-amber-600'}`}><WorkspaceIcon name="star" className={favorites.has(entry.id) ? 'fill-current' : ''} /></button></div></div>
            <p className="mb-1.5 text-[11px] font-medium text-[#557c83]">{APP_KIND_LABELS[entry.kind]}</p>
            <h2 className="text-[16px] font-semibold tracking-tight">{entry.name}</h2>
            <p className="mt-2 text-[14px] leading-relaxed text-slate-600">{entry.description}</p>
            {entry.details.length > 0 && <ul className="mt-3 space-y-1 text-[13px] text-slate-500">{entry.details.map((detail) => <li key={detail}>{detail}</li>)}</ul>}
            <div className="mt-auto pt-5">{entry.href ? entry.kind === 'link' ?
              <a href={entry.href} target="_blank" rel="noopener noreferrer" className="inline-flex rounded-lg border border-[#DCE3EC] px-4 py-2 text-sm font-medium text-[#003087] hover:border-[#003087]">외부 사이트 열기 ↗</a> :
              <Link href={entry.href} className="inline-flex rounded-lg bg-[#003087] px-4 py-2 text-sm font-medium text-white hover:bg-[#002070]">{entry.kind === 'workflow' ? '업무 시작' : entry.kind === 'form' ? '앱 실행' : '비서 열기'}</Link> :
              <p className="rounded-lg bg-slate-50 px-3 py-2 text-sm text-slate-500">{entry.unavailableReason}</p>}
            </div>
            {entry.kind === 'form' && entry.href && <Link href={`/apps/builder?copy=${encodeURIComponent(entry.id.slice(6))}`} className="mt-3 text-xs text-[#087581] underline">복사해 내 앱 만들기</Link>}
            {entry.kind === 'form' && <Link href={`/apps/history?agent=${encodeURIComponent(entry.id.slice(6))}`} className="mt-3 text-xs text-[#087581] underline">이 앱 실행 기록</Link>}
            {entry.kind === 'form' && agents.some(a => `agent:${a.id}` === entry.id && (a.owner_id === session?.user?.id || (a.tier === 'department' && a.department_id === session?.user?.departmentId))) && <Link href={`/apps/builder?agent=${encodeURIComponent(entry.id.slice(6))}`} className="mt-3 text-xs text-[#087581] underline">앱 설정 수정</Link>}
            {entry.kind === 'chat' && entry.href && <div className="mt-3 flex flex-wrap gap-2" aria-label={`${entry.name}로 업무 시작`}>{workLaunchLinks(agents.find((a) => `agent:${a.id}` === entry.id), workflows, newTasksEnabled).map((item) => <Link key={item.href} href={item.href} className="rounded-lg border border-[#DCE3EC] px-3 py-2 text-sm text-[#003087] hover:border-[#003087]">{item.label}</Link>)}</div>}
          </Card>)}</div>}
      </>}
      {creating && <CreateAgentModal onClose={() => setCreating(false)} onCreated={() => { setCreating(false); void refresh(); }} />}
    </div>
  );
}
