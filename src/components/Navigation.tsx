'use client';

import Link from 'next/link';
import { useSession, signOut } from 'next-auth/react';
import { useBranding } from '@/lib/use-branding';

export default function Navigation() {
  const { data: session, status } = useSession();
  const branding = useBranding();
  const isAuthenticated = status === 'authenticated' && !!session?.user;
  const isAdmin = isAuthenticated && session.user.role === 'ADMIN';

  return (
    <header className="bg-white border-b border-slate-200">
      <div className="flex flex-wrap items-center justify-between max-w-6xl px-6 py-4 mx-auto">
        {/* 기관 브랜딩(0020). 사이드바·헤더와 같은 값을 써야 화면마다
            다른 이름이 보이지 않는다. */}
        <Link href="/" className="flex items-center gap-2 text-lg font-bold text-slate-900">
          {branding.logoUrl ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={branding.logoUrl} alt="" className="h-6 max-w-[100px] object-contain" />
          ) : null}
          {branding.name}
        </Link>
        <nav className="flex flex-wrap gap-4 text-sm text-slate-600 items-center">
          {isAdmin ? (
            <>
              <Link href="/admin">관리자 대시보드</Link>
              <Link href="/user">사용자 페이지</Link>
            </>
          ) : isAuthenticated ? (
            <Link href="/user">내 페이지</Link>
          ) : null}
          {isAuthenticated ? (
            <button
              type="button"
              onClick={() => signOut({ callbackUrl: '/' })}
              className="text-slate-600 hover:text-slate-900"
            >
              로그아웃
            </button>
          ) : (
            <Link href="/">로그인</Link>
          )}
        </nav>
      </div>
    </header>
  );
}
