'use client';

import { useSession } from 'next-auth/react';
import Link from 'next/link';
import { useBranding } from '@/lib/use-branding';
import UserMenu from './UserMenu';

export default function Header() {
  const { data: session } = useSession();
  const branding = useBranding();
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

        <UserMenu />
      </div>
    </header>
  );
}
