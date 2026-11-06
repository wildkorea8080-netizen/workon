'use client';

import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { useSession } from 'next-auth/react';
import { Suspense, useEffect, useState, type CSSProperties, type ReactNode } from 'react';
import Header from '@/components/layout/Header';
import UserMenu from '@/components/layout/UserMenu';
import NoticesBanner from '@/components/NoticesBanner';
import WorkspaceIcon from './WorkspaceIcon';
import RecentConversations from './RecentConversations';
import { readSidebarCollapsed, writeSidebarCollapsed } from '@/lib/sidebar-pref';
import { useBranding } from '@/lib/use-branding';
import { themeStyle } from '@/lib/theme-color';
import { brandInitial } from '@/lib/branding';

/**
 * 업무 화면 틀 — 기존 헤더(기관 브랜딩·관리자 메뉴)와 공지 배너를 그대로 쓰고 왼쪽에 업무 메뉴를 둔다.
 * 768px 이하에서는 메뉴가 위쪽 가로 탭이 된다(개편 03 문서 '디자인 기준').
 */
const NAV = [
  { href: '/', icon: 'home', label: '업무 홈', match: (p: string) => p === '/' },
  { href: '/apps', icon: 'apps', label: '업무 앱', match: (p: string) => p.startsWith('/apps') && !p.startsWith('/apps/history') && !p.startsWith('/apps/schedules') && !p.startsWith('/apps/webhooks') },
  { href: '/apps/history', icon: 'tasks', label: '앱 실행 기록', match: (p: string) => p.startsWith('/apps/history') },
  { href: '/apps/schedules', icon: 'tasks', label: '앱 예약·연동', match: (p: string) => p.startsWith('/apps/schedules') || p.startsWith('/apps/webhooks') },
  { href: '/assistants', icon: 'assistant', label: '업무 비서', match: (p: string) => p.startsWith('/assistants') },
  { href: '/tasks', icon: 'tasks', label: '내 작업함', match: (p: string) => p.startsWith('/tasks') },
  { href: '/files', icon: 'files', label: '결과물', match: (p: string) => p.startsWith('/files') },
  { href: '/templates', icon: 'template', label: '양식', match: (p: string) => p.startsWith('/templates') },
  { href: '/chat', icon: 'chat', label: 'AI 대화', match: (p: string) => p.startsWith('/chat') },
];

/** 사이드바 아래 — 위쪽 막대에 있던 링크(관리자 포털은 관리자만) */
const FOOTER = [
  { href: '/my/stats', icon: 'stats', label: '내 사용현황', admin: false },
  { href: '/admin', icon: 'admin', label: '관리자 포털', admin: true },
];

export default function WorkShell({ children }: { children: ReactNode }) {
  const { data: session, status } = useSession();
  const router = useRouter();
  const pathname = usePathname() ?? '/';
  // 기관 테마 색(0067) — 없으면 globals.css :root의 기본 청록 그대로
  const branding = useBranding();
  const { themeColor } = branding;
  const isAdmin = session?.user?.role === 'ADMIN';
  // 사이드바 접기 — 서버 렌더링과 어긋나지 않게 펼친 채로 그리고 마운트 뒤 이 브라우저에 기억한 값을 읽는다
  const [collapsed, setCollapsed] = useState(false);
  useEffect(() => setCollapsed(readSidebarCollapsed()), []);
  function toggleSidebar() {
    setCollapsed((c) => {
      writeSidebarCollapsed(!c);
      return !c;
    });
  }

  useEffect(() => {
    if (status === 'unauthenticated') router.replace('/login');
  }, [status, router]);

  if (status !== 'authenticated' || !session) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-[#F5F7FA]" role="status" aria-live="polite">
        <span className="text-[15px] text-slate-500">불러오는 중…</span>
      </div>
    );
  }

  return (
    <div className="workspace-shell flex flex-col h-screen bg-[#F7F8FC] text-[#22283D]" style={{ fontFamily: 'Pretendard, -apple-system, sans-serif', ...((themeStyle(themeColor) ?? {}) as CSSProperties) }}>
      {/* 넓은 화면은 위쪽 막대 없이 사이드바 하나(2026-11-06 — 기관 로고는 사이드바 맨 위, 사용자 메뉴는 맨 아래). 작은 화면은 사이드바가 없어 막대를 둔다 */}
      <div className="md:hidden"><Header /></div>
      <NoticesBanner />
      <nav aria-label="업무 메뉴" className="md:hidden flex gap-1 overflow-x-auto border-b border-[#DCE3EC] bg-white px-4 py-2">
        {NAV.map((n) => (
          <Link
            key={n.href}
            href={n.href}
            aria-current={n.match(pathname) ? 'page' : undefined}
            className={`whitespace-nowrap rounded-lg px-3 py-2 text-[14px] ${n.match(pathname) ? 'bg-[#003087] text-white' : 'text-slate-600 hover:bg-slate-100'}`}
          >
            {n.label}
          </Link>
        ))}
      </nav>
      <div className="flex flex-1 overflow-hidden">
        {/* 사이드바 하나 — 위에 업무 메뉴, 아래에 최근 대화(2026-11-06, 대화 화면의 둘째 칸을 없앰) */}
        <div
          className={`workspace-sidebar hidden md:flex ${collapsed ? 'w-[72px] px-3' : 'w-64 px-4'} flex-shrink-0 flex-col border-r border-[#E9EBF2] bg-white pb-3 pt-4 transition-[width] duration-150`}
          data-collapsed={collapsed ? 'true' : undefined}
        >
          <div className={`flex pb-3 pt-1 ${collapsed ? 'flex-col items-center gap-2' : 'items-center justify-between gap-2 pl-1'}`}>
            <Link href="/" aria-label={`${branding.name} 업무 홈`} title={collapsed ? branding.name : undefined} className="workspace-brand flex min-w-0 items-center gap-2 rounded-lg hover:opacity-80 focus:outline-none focus-visible:ring-2 focus-visible:ring-ws-accent">
              {branding.logoUrl && !collapsed ? (
                // 가로로 긴 CI가 흔해 사이드바 너비만큼 준다. 접으면 첫 글자 칸만
                // eslint-disable-next-line @next/next/no-img-element
                <img src={branding.logoUrl} alt={branding.name} className="h-9 max-w-[172px] object-contain object-left" />
              ) : (
                <>
                  <span aria-hidden="true" className="flex h-9 w-9 flex-shrink-0 items-center justify-center rounded-xl bg-ws-accent text-base font-bold text-white">{brandInitial(branding.name)}</span>
                  {!collapsed && <span className="truncate text-[15px] font-bold tracking-tight text-slate-900">{branding.name}</span>}
                </>
              )}
            </Link>
            <button
              type="button"
              onClick={toggleSidebar}
              aria-expanded={!collapsed}
              aria-label={collapsed ? '사이드바 펼치기' : '사이드바 접기'}
              title={collapsed ? '사이드바 펼치기' : '사이드바 접기'}
              className="flex-shrink-0 rounded-lg p-1.5 text-slate-400 hover:bg-slate-50 hover:text-slate-700 focus:outline-none focus-visible:ring-2 focus-visible:ring-ws-accent"
            >
              <WorkspaceIcon name="panel" />
            </button>
          </div>
          {/* 가운데(새 업무·업무 메뉴·최근 대화)만 내린다 — 창이 낮아도(작은 노트북·화면 확대) 위 로고·접기와 아래 사용자 메뉴·로그아웃이 잘리지 않게 */}
          <div className="workspace-sidebar-middle -mx-1 flex min-h-0 flex-1 flex-col overflow-y-auto px-1">
          <Link
            href="/apps"
            aria-label={collapsed ? '새 업무 시작' : undefined}
            title={collapsed ? '새 업무 시작' : undefined}
            className={`workspace-new mb-3 flex items-center justify-center gap-2 rounded-xl bg-ws-accent text-sm font-semibold text-white hover:bg-ws-accent-hover ${collapsed ? 'p-2.5' : 'px-4 py-2.5'}`}
          >
            <WorkspaceIcon name="plus" />{!collapsed && '새 업무 시작'}
          </Link>
          <nav aria-label="업무 메뉴" className="mb-3 flex flex-shrink-0 flex-col gap-0.5">
            {NAV.map((n) => (
              <Link
                key={n.href}
                href={n.href}
                aria-current={n.match(pathname) ? 'page' : undefined}
                aria-label={collapsed ? n.label : undefined}
                title={collapsed ? n.label : undefined}
                className={`flex items-center rounded-xl py-2 text-[14px] focus:outline-none focus-visible:ring-2 focus-visible:ring-ws-accent ${collapsed ? 'justify-center px-2' : 'gap-3 px-3'} ${
                  n.match(pathname) ? 'bg-ws-accent-soft text-ws-accent-text font-semibold' : 'text-slate-500 hover:bg-slate-50 hover:text-slate-900'
                }`}
              >
                <WorkspaceIcon name={n.icon} />{!collapsed && n.label}
              </Link>
            ))}
          </nav>
          {/* 접으면 최근 대화는 숨긴다 — 'AI 대화' 아이콘으로 대화 화면에 간다(작은 화면의 '지난 대화' 펼치기는 그대로) */}
          {!collapsed && <Suspense fallback={null}><RecentConversations /></Suspense>}
          </div>
          {/* 아래 — 내 사용현황·관리자 포털·사용자 메뉴(위쪽 막대에 있던 것) */}
          <div className="mt-auto flex flex-shrink-0 flex-col gap-0.5 border-t border-[#E9EBF2] pt-3">
            {FOOTER.filter((f) => !f.admin || isAdmin).map((f) => (
              <Link
                key={f.href}
                href={f.href}
                aria-label={collapsed ? f.label : undefined}
                title={collapsed ? f.label : undefined}
                className={`flex items-center rounded-xl py-2 text-[13px] text-slate-500 hover:bg-slate-50 hover:text-slate-900 focus:outline-none focus-visible:ring-2 focus-visible:ring-ws-accent ${collapsed ? 'justify-center px-2' : 'gap-3 px-3'}`}
              >
                <WorkspaceIcon name={f.icon} />{!collapsed && f.label}
              </Link>
            ))}
            <div className={collapsed ? 'flex justify-center pt-1' : 'pt-1'}>
              <UserMenu up compact={collapsed} wide={!collapsed} />
            </div>
          </div>
        </div>
        <main id="workspace-content" className="min-w-0 flex-1 overflow-y-auto">{children}</main>
      </div>
    </div>
  );
}

export function PageTitle({ title, subtitle, action }: { title: string; subtitle?: string; action?: ReactNode }) {
  return (
    <div className="workspace-page-title flex flex-wrap items-end justify-between gap-4 mb-8">
      <div>
        <h1 className="text-[26px] font-bold leading-tight tracking-tight">{title}</h1>
        {subtitle && <p className="mt-2 text-[14px] leading-6 text-slate-500">{subtitle}</p>}
      </div>
      {action}
    </div>
  );
}

export function Card({ children, className = '' }: { children: ReactNode; className?: string }) {
  return <section className={`workspace-card rounded-2xl border border-[#E7E9F1] bg-white p-6 ${className}`}>{children}</section>;
}

export function ErrorNote({ message }: { message: string | null }) {
  if (!message) return null;
  return (
    <p role="alert" className="rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-[14px] text-red-800">
      {message}
    </p>
  );
}

export function StatusBadge({ label, tone = 'neutral' }: { label: string; tone?: 'neutral' | 'warn' | 'ok' | 'busy' | 'bad' }) {
  const cls = {
    neutral: 'bg-slate-100 text-slate-700',
    warn: 'bg-amber-50 text-amber-800 border border-amber-200',
    ok: 'bg-emerald-50 text-emerald-800 border border-emerald-200',
    busy: 'bg-blue-50 text-blue-800 border border-blue-200',
    bad: 'bg-red-50 text-red-800 border border-red-200',
  }[tone];
  return <span className={`inline-flex items-center rounded-md px-2 py-0.5 text-[13px] font-medium ${cls}`}>{label}</span>;
}

export function statusTone(status: string): 'neutral' | 'warn' | 'ok' | 'busy' | 'bad' {
  if (status === 'needs_review' || status === 'draft') return 'warn';
  if (status === 'completed' || status === 'approved') return 'ok';
  if (status === 'processing') return 'busy';
  return 'neutral';
}
