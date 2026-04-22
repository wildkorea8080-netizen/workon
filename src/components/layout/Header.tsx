'use client';

import { useState, useRef, useEffect } from 'react';
import { useSession, signOut } from 'next-auth/react';
import Link from 'next/link';

export default function Header() {
  const { data: session } = useSession();
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
    <header className="fixed top-0 left-0 right-0 z-50 h-14 bg-[#1C2B4A] flex items-center px-5 gap-4 shadow-md">
      {/* 로고 */}
      <div className="flex items-center gap-2 flex-shrink-0">
        <span className="text-xl">🏛️</span>
        <span className="text-white font-bold text-base tracking-tight">AI 업무도우미</span>
      </div>

      <div className="flex-1" />

      {/* 우측 메뉴 */}
      <div className="flex items-center gap-4">
        <Link
          href="/my/stats"
          className="text-white/60 hover:text-white text-sm transition-colors"
        >
          내 사용현황
        </Link>

        {isAdmin && (
          <Link
            href="/admin"
            className="text-white/60 hover:text-white text-sm transition-colors"
          >
            관리자 포털
          </Link>
        )}

        {/* 사용자 드롭다운 */}
        <div ref={dropdownRef} className="relative">
          <button
            onClick={() => setDropdownOpen(v => !v)}
            className="flex items-center gap-1.5 text-white text-sm font-medium hover:text-white/80 transition-colors"
          >
            <div className="w-7 h-7 rounded-full bg-white/20 flex items-center justify-center text-xs font-bold">
              {userName.slice(0, 1).toUpperCase()}
            </div>
            <span>{userName}님</span>
            <svg className={`w-3.5 h-3.5 text-white/60 transition-transform ${dropdownOpen ? 'rotate-180' : ''}`} fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
            </svg>
          </button>

          {dropdownOpen && (
            <div className="absolute right-0 top-full mt-2 w-44 bg-white rounded-xl shadow-lg border border-slate-100 py-1 z-50">
              <div className="px-4 py-2.5 border-b border-slate-100">
                <p className="text-xs font-semibold text-slate-900">{userName}</p>
                <p className="text-xs text-slate-400 truncate">{session?.user?.email}</p>
              </div>
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
