'use client';

import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { useSession } from 'next-auth/react';
import { Suspense, useEffect, useState, type CSSProperties, type ReactNode } from 'react';
import Header from '@/components/layout/Header';
import NoticesBanner from '@/components/NoticesBanner';
import WorkspaceIcon from './WorkspaceIcon';
import RecentConversations from './RecentConversations';
import { readSidebarCollapsed, writeSidebarCollapsed } from '@/lib/sidebar-pref';
import { useBranding } from '@/lib/use-branding';
import { themeStyle } from '@/lib/theme-color';

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

export default function WorkShell({ children }: { children: ReactNode }) {
  const { data: session, status } = useSession();
  const router = useRouter();
  const pathname = usePathname() ?? '/';
  // 기관 테마 색(0067) — 없으면 globals.css :root의 기본 청록 그대로
  const { themeColor } = useBranding();
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
      <Header />
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
          <div className={`flex items-center pb-3 pt-1 ${collapsed ? 'justify-center' : 'justify-between pl-3'}`}>
            {!collapsed && <p className="text-[11px] font-bold tracking-[.16em] text-slate-400">WORKSPACE</p>}
            <button
              type="button"
              onClick={toggleSidebar}
              aria-expanded={!collapsed}
              aria-label={collapsed ? '사이드바 펼치기' : '사이드바 접기'}
              title={collapsed ? '사이드바 펼치기' : '사이드바 접기'}
              className="rounded-lg p-1.5 text-slate-400 hover:bg-slate-50 hover:text-slate-700 focus:outline-none focus-visible:ring-2 focus-visible:ring-ws-accent"
            >
              <WorkspaceIcon name="panel" />
            </button>
          </div>
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
