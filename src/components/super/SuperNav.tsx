'use client';

import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';

const NAV_ITEMS = [
  { href: '/super',              label: '대시보드',        icon: '📊', exact: true  },
  { href: '/super/organizations',label: '기관 관리',       icon: '🏢'               },
  { href: '/super/accounts',     label: '계정 관리',       icon: '👤'               },
  { href: '/super/api-keys',     label: 'API 관리',        icon: '🔑'               },
  { href: '/super/usage',        label: '사용량 모니터링', icon: '📈'               },
  { href: '/super/contracts',    label: '계약/과금',       icon: '💰'               },
  { href: '/super/notices',      label: '공지사항',        icon: '📢'               },
  { href: '/super/settings',     label: '시스템 설정',     icon: '⚙️'              },
  { href: '/super/logs',         label: '로그',            icon: '📋'               },
] as const;

interface SuperNavProps {
  adminName: string;
  adminEmail: string;
}

export default function SuperNav({ adminName, adminEmail }: SuperNavProps) {
  const pathname = usePathname();
  const router = useRouter();

  const handleLogout = async () => {
    await fetch('/api/super/auth/logout', { method: 'POST' });
    router.push('/super/login');
    router.refresh();
  };

  return (
    <aside className="w-60 bg-[#1E293B] border-r border-slate-700/50 flex flex-col flex-shrink-0">
      {/* 로고 */}
      <div className="px-5 py-5 border-b border-slate-700/50">
        <div className="flex items-center gap-2.5">
          <div className="w-8 h-8 rounded-lg bg-[#7C3AED]/20 border border-[#7C3AED]/30 flex items-center justify-center text-base flex-shrink-0">
            🔐
          </div>
          <div className="min-w-0">
            <p className="text-xs font-bold text-white leading-tight">SUPER ADMIN</p>
            <p className="text-[10px] text-slate-500 mt-0">WORKON 운영자 포털</p>
          </div>
        </div>
      </div>

      {/* 네비게이션 */}
      <nav className="flex-1 px-3 py-4 overflow-y-auto space-y-0.5">
        {NAV_ITEMS.map(item => {
          const isActive = item.exact
            ? pathname === item.href
            : pathname.startsWith(item.href);
          return (
            <Link
              key={item.href}
              href={item.href}
              className={`flex items-center gap-2.5 px-3 py-2.5 rounded-xl text-sm font-medium transition-all ${
                isActive
                  ? 'bg-[#7C3AED] text-white shadow-sm'
                  : 'text-slate-400 hover:text-white hover:bg-slate-700/50'
              }`}
            >
              <span className="text-base leading-none">{item.icon}</span>
              {item.label}
              {isActive && <span className="ml-auto w-1.5 h-1.5 rounded-full bg-white/60" />}
            </Link>
          );
        })}
      </nav>

      {/* 하단 프로필 */}
      <div className="px-4 py-4 border-t border-slate-700/50">
        <div className="flex items-center gap-2.5 mb-3">
          <div className="w-8 h-8 rounded-lg bg-[#7C3AED] flex items-center justify-center text-white text-xs font-bold flex-shrink-0">
            {adminName.charAt(0).toUpperCase()}
          </div>
          <div className="min-w-0">
            <p className="text-xs font-semibold text-white truncate">{adminName}</p>
            <p className="text-[10px] text-slate-500 truncate">{adminEmail}</p>
          </div>
        </div>
        <button
          onClick={handleLogout}
          className="w-full flex items-center justify-center gap-2 px-3 py-2 text-xs font-medium text-slate-400 hover:text-red-400 hover:bg-red-900/20 rounded-lg transition-colors"
        >
          <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M17 16l4-4m0 0l-4-4m4 4H7m6 4v1a3 3 0 01-3 3H6a3 3 0 01-3-3V7a3 3 0 013-3h4a3 3 0 013 3v1" />
          </svg>
          로그아웃
        </button>
      </div>
    </aside>
  );
}
