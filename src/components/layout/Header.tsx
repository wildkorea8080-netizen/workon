'use client';

import { useState, useRef, useEffect } from 'react';
import { useSession, signOut } from 'next-auth/react';
import Link from 'next/link';
import { useBranding } from '@/lib/use-branding';

export default function Header() {
  const { data: session } = useSession();
  const branding = useBranding();
  const [dropdownOpen, setDropdownOpen] = useState(false);
  const dropdownRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    function handleClick(e: MouseEvent) {
      if (dropdownRef.current && !dropdownRef.current.contains(e.target as Node)) {
        setDropdownOpen(false);
      }
    }
    document.addEventListener('mousedown', handleClick);
    return () => document.removeEventListener('mousedown', handleClick);
  }, []);

  const userName = session?.user?.name || session?.user?.email?.split('@')[0] || '사용자';
  const isAdmin = session?.user?.role === 'ADMIN';

  return (
    // 흰 바탕이다. 기관 CI 로고는 대부분 흰 배경 기준으로 제작되고, 공공기관
    // CI 사용 규정에 배경색이 지정된 경우도 있다. 짙은 색 위에 얹으면 로고의
    // 테두리와 색이 뭉개져 "우리 기관 시스템"으로 보이지 않는다.
    <header className="workspace-header flex-shrink-0 z-40 h-[72px] bg-white border-b border-[#E9EBF2] flex items-center px-4 md:px-7 gap-3 md:gap-5">
      {/* 로고 — 좌측 상단에 크게. 기관 정체성이 첫눈에 보여야 한다. */}
      <Link href="/" className="flex items-center gap-2.5 flex-shrink-0 hover:opacity-80 transition-opacity">
        {branding.logoUrl ? (
          // 가로로 긴 CI(엠블럼+워드마크)가 흔해 너비를 넉넉히 준다.
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={branding.logoUrl}
            alt={branding.name}
            className="h-10 max-w-[140px] sm:max-w-[240px] object-contain object-left"
          />
        ) : (
          <>
            <span aria-hidden="true" className="flex h-9 w-9 items-center justify-center rounded-xl bg-ws-accent text-lg font-bold text-white">W</span>
            <span className="max-w-[130px] truncate text-slate-900 font-bold text-lg tracking-tight sm:max-w-[240px]">{branding.name}</span>
          </>
        )}
      </Link>

      <div className="flex-1" />

      <Link href="/apps" className="hidden rounded-lg border md:inline-flex border-[#DCE3EC] px-3 py-2 text-sm font-semibold text-[#003087] hover:bg-slate-50">업무 앱</Link>

      {/* 우측 메뉴 */}
      <div className="flex items-center gap-3 md:gap-5">
        <Link
          href="/my/stats"
          className="hidden lg:block text-slate-500 hover:text-[#003087] text-sm font-medium transition-colors"
        >
          내 사용현황
        </Link>

        {isAdmin && (
          <Link
            href="/admin"
            className="hidden sm:block text-slate-500 hover:text-[#003087] text-sm font-medium transition-colors"
          >
            관리자 포털
          </Link>
        )}

        {/* 사용자 드롭다운 */}
        <div ref={dropdownRef} className="relative">
          <button
            type="button"
            aria-label="사용자 메뉴"
            aria-expanded={dropdownOpen}
            onClick={() => setDropdownOpen(v => !v)}
            className="flex items-center gap-1.5 text-slate-700 text-sm font-medium hover:text-slate-900 transition-colors"
          >
            <div className="w-7 h-7 rounded-full bg-[#003087] text-white flex items-center justify-center text-xs font-bold">
              {userName.slice(0, 1).toUpperCase()}
            </div>
            <span className="hidden max-w-[120px] truncate sm:inline">{userName}님</span>
            <svg className={`w-3.5 h-3.5 text-slate-400 transition-transform ${dropdownOpen ? 'rotate-180' : ''}`} fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
            </svg>
          </button>

          {dropdownOpen && (
            <div className="absolute right-0 top-full mt-2 w-44 bg-white rounded-xl shadow-lg border border-slate-100 py-1 z-50">
              <div className="px-4 py-2.5 border-b border-slate-100">
                <p className="text-xs font-semibold text-slate-900">{userName}</p>
                <p className="text-xs text-slate-400 truncate">{session?.user?.email}</p>
              </div>
              <Link href="/my/stats" className="block px-4 py-2.5 text-sm text-slate-600 hover:bg-slate-50" onClick={() => setDropdownOpen(false)}>내 사용현황</Link>
              {isAdmin && <Link href="/admin" className="block px-4 py-2.5 text-sm text-slate-600 hover:bg-slate-50" onClick={() => setDropdownOpen(false)}>관리자 포털</Link>}
              <button
                onClick={() => signOut({ callbackUrl: '/login' })}
                className="w-full text-left px-4 py-2.5 text-sm text-red-500 hover:bg-red-50 transition-colors"
              >
                로그아웃
              </button>
            </div>
          )}
        </div>
      </div>
    </header>
  );
}
