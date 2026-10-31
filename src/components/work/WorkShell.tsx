'use client';

import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { useSession } from 'next-auth/react';
import { useEffect, type ReactNode } from 'react';
import Header from '@/components/layout/Header';
import NoticesBanner from '@/components/NoticesBanner';
import WorkspaceIcon from './WorkspaceIcon';

/**
 * 업무 화면 틀 — 기존 헤더(기관 브랜딩·관리자 메뉴)와 공지 배너를 그대로 쓰고 왼쪽에 업무 메뉴를 둔다.
 * 768px 이하에서는 메뉴가 위쪽 가로 탭이 된다(개편 03 문서 '디자인 기준').
 */
const NAV = [
  { href: '/', icon: 'home', label: '업무 홈', match: (p: string) => p === '/' },
  { href: '/apps', icon: 'apps', label: '업무 앱', match: (p: string) => p.startsWith('/apps') && !p.startsWith('/apps/history') },
  { href: '/apps/history', icon: 'tasks', label: '앱 실행 기록', match: (p: string) => p.startsWith('/apps/history') },
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
    <div className="workspace-shell flex flex-col h-screen bg-[#F7F8FC] text-[#22283D]" style={{ fontFamily: 'Pretendard, -apple-system, sans-serif' }}>
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
        <nav aria-label="업무 메뉴" className="workspace-sidebar hidden md:flex w-60 flex-shrink-0 flex-col gap-1 border-r border-[#E9EBF2] bg-white p-4">
          <div className="px-3 pb-5 pt-3"><p className="text-[11px] font-bold tracking-[.16em] text-slate-400">WORKSPACE</p><p className="mt-2 text-sm font-semibold text-slate-700">나의 업무 공간</p></div>
          <Link href="/apps" className="workspace-new mb-5 flex items-center justify-center gap-2 rounded-xl bg-[#087f8c] px-4 py-3 text-sm font-semibold text-white hover:bg-[#066775]"><WorkspaceIcon name="plus" />새 업무 시작</Link>
          {NAV.map((n) => (
            <Link
              key={n.href}
              href={n.href}
              aria-current={n.match(pathname) ? 'page' : undefined}
              className={`flex items-center gap-3 rounded-xl px-3 py-3 text-[14px] focus:outline-none focus-visible:ring-2 focus-visible:ring-[#087f8c] ${
                n.match(pathname) ? 'bg-[#e7f5f5] text-[#087581] font-semibold' : 'text-slate-500 hover:bg-slate-50 hover:text-slate-900'
              }`}
            >
              <WorkspaceIcon name={n.icon} />{n.label}
            </Link>
          ))}
          <div className="mt-auto rounded-xl border border-[#dfeded] bg-[#f3f9f9] p-4"><WorkspaceIcon name="spark" className="mb-2 text-[#16818c]" /><p className="text-xs font-semibold text-slate-700">자료에서 결과물까지</p><p className="mt-1.5 text-xs leading-5 text-slate-500">초안을 만들고 근거를 검토해<br />업무에 필요한 파일로 받으세요.</p></div>
        </nav>
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
