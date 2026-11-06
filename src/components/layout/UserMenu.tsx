'use client';

import { useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { signOut, useSession } from 'next-auth/react';

/**
 * 사용자 메뉴(이름 → 내 사용현황·관리자 포털·로그아웃) — 위쪽 머리 막대와 업무 틀 사이드바 아래(2026-11-06)가 함께 쓴다.
 * `up`이면 메뉴가 위로 열린다(사이드바 맨 아래), `compact`면 이름 없이 첫 글자 동그라미만(접은 사이드바).
 */
export default function UserMenu({ up = false, compact = false, wide = false }: { up?: boolean; compact?: boolean; wide?: boolean }) {
  const { data: session } = useSession();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    function handleClick(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    }
    function handleKey(e: KeyboardEvent) {
      if (e.key === 'Escape') setOpen(false);
    }
    document.addEventListener('mousedown', handleClick);
    document.addEventListener('keydown', handleKey);
    return () => {
      document.removeEventListener('mousedown', handleClick);
      document.removeEventListener('keydown', handleKey);
    };
  }, []);

  const userName = session?.user?.name || session?.user?.email?.split('@')[0] || '사용자';
  const isAdmin = session?.user?.role === 'ADMIN';

  return (
    <div ref={ref} className={`relative ${wide ? 'w-full' : ''}`}>
      <button
        type="button"
        aria-label={compact ? `사용자 메뉴 — ${userName}님` : '사용자 메뉴'}
        title={compact ? `${userName}님` : undefined}
        aria-expanded={open}
        aria-haspopup="menu"
        onClick={() => setOpen((v) => !v)}
        className={`flex items-center gap-1.5 rounded-xl text-sm font-medium text-slate-700 transition-colors hover:text-slate-900 focus:outline-none focus-visible:ring-2 focus-visible:ring-ws-accent ${wide ? 'w-full px-3 py-2 hover:bg-slate-50' : ''} ${compact ? 'justify-center px-0' : ''}`}
      >
        <span className="flex h-7 w-7 flex-shrink-0 items-center justify-center rounded-full bg-ws-accent text-xs font-bold text-white">
          {userName.slice(0, 1).toUpperCase()}
        </span>
        {!compact && <span className={`truncate ${wide ? 'flex-1 text-left' : 'hidden max-w-[120px] sm:inline'}`}>{userName}님</span>}
        {!compact && (
          <svg aria-hidden="true" className={`h-3.5 w-3.5 flex-shrink-0 text-slate-400 transition-transform ${open !== up ? 'rotate-180' : ''}`} fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
          </svg>
        )}
      </button>

      {open && (
        <div
          role="menu"
          className={`absolute z-50 w-48 rounded-xl border border-slate-100 bg-white py-1 shadow-lg ${up ? 'bottom-full left-0 mb-2' : 'right-0 top-full mt-2'}`}
        >
          <div className="border-b border-slate-100 px-4 py-2.5">
            <p className="text-xs font-semibold text-slate-900">{userName}</p>
            <p className="truncate text-xs text-slate-400">{session?.user?.email}</p>
          </div>
          <Link role="menuitem" href="/my/stats" className="block px-4 py-2.5 text-sm text-slate-600 hover:bg-slate-50" onClick={() => setOpen(false)}>내 사용현황</Link>
          {isAdmin && <Link role="menuitem" href="/admin" className="block px-4 py-2.5 text-sm text-slate-600 hover:bg-slate-50" onClick={() => setOpen(false)}>관리자 포털</Link>}
          <button
            role="menuitem"
            type="button"
            onClick={() => signOut({ callbackUrl: '/login' })}
            className="w-full px-4 py-2.5 text-left text-sm text-red-500 transition-colors hover:bg-red-50"
          >
            로그아웃
          </button>
        </div>
      )}
    </div>
  );
}
