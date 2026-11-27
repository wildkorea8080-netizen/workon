'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useEffect, useState } from 'react';
import WorkspaceIcon from '@/components/work/WorkspaceIcon';
import { ADMIN_NAV, isAdminNavActive } from '@/components/admin/AdminNav';
import { readSidebarCollapsed, writeSidebarCollapsed } from '@/lib/sidebar-pref';
import { brandInitial } from '@/lib/branding';

/**
 * 관리자 포털 틀의 메뉴(2026-11-27) — 직원 화면(업무 틀 WorkShell)과 같은 밝은 사이드바·기관 테마 색.
 * 넓은 화면은 왼쪽 사이드바(접기는 직원 화면과 같은 기억), 768px 미만은 위쪽 막대 + 가로 탭.
 * 예전엔 짙은 남색 사이드바에 흰 판 로고라 직원 화면과 다른 제품처럼 보였고, 작은 화면 처리가 없었다
 */
export default function AdminSidebar({ brandName, brandLogo, email, isImpersonating }: {
  brandName: string;
  brandLogo: string | null;
  email: string;
  isImpersonating: boolean;
}) {
  const pathname = usePathname() ?? '/admin';
  // 서버 렌더링과 어긋나지 않게 펼친 채로 그리고 마운트 뒤 이 브라우저에 기억한 값을 읽는다
  const [collapsed, setCollapsed] = useState(false);
  useEffect(() => setCollapsed(readSidebarCollapsed()), []);
  function toggle() {
    setCollapsed((c) => {
      writeSidebarCollapsed(!c);
      return !c;
    });
  }
  const role = isImpersonating ? '대리 접근 중' : '관리자';

  return (
    <>
      {/* 작은 화면 — 위쪽 막대와 가로 탭 */}
      <div className={`md:hidden flex-shrink-0 border-b border-[#E9EBF2] bg-white ${isImpersonating ? 'mt-[52px]' : ''}`}>
        <div className="flex items-center justify-between gap-3 px-4 pt-3">
          <Link href="/admin" className="flex min-w-0 items-center gap-2">
            {brandLogo ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img src={brandLogo} alt={brandName} className="h-8 max-w-[160px] object-contain object-left" />
            ) : (
              <>
                <span aria-hidden="true" className="flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-xl bg-ws-accent text-sm font-bold text-white">{brandInitial(brandName)}</span>
                <span className="truncate text-[15px] font-bold text-slate-900">{brandName}</span>
              </>
            )}
            <span className="whitespace-nowrap text-[12px] text-slate-400">관리자 포털</span>
          </Link>
          <Link href="/" className="whitespace-nowrap text-[13px] font-medium text-ws-accent-text">업무 화면으로</Link>
        </div>
        <nav aria-label="관리자 메뉴" className="flex gap-1 overflow-x-auto px-4 py-2">
          {ADMIN_NAV.map((item) => {
            const active = isAdminNavActive(item, pathname);
            return (
              <Link
                key={item.href}
                href={item.href}
                aria-current={active ? 'page' : undefined}
                className={`whitespace-nowrap rounded-lg px-3 py-2 text-[14px] ${active ? 'bg-ws-accent text-white' : 'text-slate-600 hover:bg-slate-100'}`}
              >
                {item.label}
              </Link>
            );
          })}
        </nav>
      </div>

      {/* 넓은 화면 — 왼쪽 사이드바 */}
      <aside
        className={`hidden md:flex ${isImpersonating ? 'mt-[52px]' : ''} ${collapsed ? 'w-[72px] px-3' : 'w-64 px-4'} flex-shrink-0 flex-col border-r border-[#E9EBF2] bg-white pb-3 pt-4 transition-[width] duration-150`}
        data-collapsed={collapsed ? 'true' : undefined}
      >
        <div className={`flex pb-3 pt-1 ${collapsed ? 'flex-col items-center gap-2' : 'items-center justify-between gap-2 pl-1'}`}>
          <Link href="/admin" aria-label={`${brandName} 관리자 포털`} title={collapsed ? brandName : undefined} className="flex min-w-0 flex-col rounded-lg hover:opacity-80 focus:outline-none focus-visible:ring-2 focus-visible:ring-ws-accent">
            <span className="flex min-w-0 items-center gap-2">
              {brandLogo && !collapsed ? (
                // 가로로 긴 CI가 흔해 사이드바 너비만큼 준다. 접으면 첫 글자 칸만
                // eslint-disable-next-line @next/next/no-img-element
                <img src={brandLogo} alt={brandName} className="h-9 max-w-[172px] object-contain object-left" />
              ) : (
                <>
                  <span aria-hidden="true" className="flex h-9 w-9 flex-shrink-0 items-center justify-center rounded-xl bg-ws-accent text-base font-bold text-white">{brandInitial(brandName)}</span>
                  {!collapsed && <span className="truncate text-[15px] font-bold tracking-tight text-slate-900">{brandName}</span>}
                </>
              )}
            </span>
            {!collapsed && <span className="mt-1 pl-0.5 text-[12px] font-medium text-slate-400">관리자 포털{isImpersonating ? ' (대리)' : ''}</span>}
          </Link>
          <button
            type="button"
            onClick={toggle}
            aria-expanded={!collapsed}
            aria-label={collapsed ? '사이드바 펼치기' : '사이드바 접기'}
            title={collapsed ? '사이드바 펼치기' : '사이드바 접기'}
            className="flex-shrink-0 rounded-lg p-1.5 text-slate-400 hover:bg-slate-50 hover:text-slate-700 focus:outline-none focus-visible:ring-2 focus-visible:ring-ws-accent"
          >
            <WorkspaceIcon name="panel" />
          </button>
        </div>

        <nav aria-label="관리자 메뉴" className="-mx-1 flex min-h-0 flex-1 flex-col gap-0.5 overflow-y-auto px-1">
          {ADMIN_NAV.map((item) => {
            const active = isAdminNavActive(item, pathname);
            return (
              <Link
                key={item.href}
                href={item.href}
                aria-current={active ? 'page' : undefined}
                aria-label={collapsed ? item.label : undefined}
                title={collapsed ? item.label : undefined}
                className={`flex items-center rounded-xl py-2 text-[14px] focus:outline-none focus-visible:ring-2 focus-visible:ring-ws-accent ${collapsed ? 'justify-center px-2' : 'gap-3 px-3'} ${
                  active ? 'bg-ws-accent-soft text-ws-accent-text font-semibold' : 'text-slate-500 hover:bg-slate-50 hover:text-slate-900'
                }`}
              >
                <span className="flex-shrink-0">{item.icon}</span>{!collapsed && item.label}
              </Link>
            );
          })}
        </nav>

        <div className="mt-3 flex flex-shrink-0 flex-col gap-1 border-t border-[#E9EBF2] pt-3">
          <div className={`flex items-center ${collapsed ? 'justify-center' : 'gap-2.5 px-2'}`} title={collapsed ? `${email} · ${role}` : undefined}>
            <span className={`flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-full text-xs font-bold text-white ${isImpersonating ? 'bg-amber-500' : 'bg-ws-accent'}`}>
              {email?.[0]?.toUpperCase() ?? 'A'}
            </span>
            {!collapsed && (
              <span className="min-w-0">
                <span className="block truncate text-[13px] font-semibold text-slate-800">{email}</span>
                <span className={`block text-[12px] ${isImpersonating ? 'font-medium text-amber-600' : 'text-slate-400'}`}>{role}</span>
              </span>
            )}
          </div>
          <Link
            href="/"
            aria-label={collapsed ? '업무 화면으로' : undefined}
            title={collapsed ? '업무 화면으로' : undefined}
            className={`flex items-center rounded-xl py-2 text-[13px] text-slate-500 hover:bg-slate-50 hover:text-slate-900 focus:outline-none focus-visible:ring-2 focus-visible:ring-ws-accent ${collapsed ? 'justify-center px-2' : 'gap-3 px-3'}`}
          >
            <WorkspaceIcon name="home" />{!collapsed && '업무 화면으로'}
          </Link>
        </div>
      </aside>
    </>
  );
}
