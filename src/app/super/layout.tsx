import { redirect } from 'next/navigation';
import { headers } from 'next/headers';
import { getSuperAdminSession } from '@/lib/super-auth';
import SuperNav from '@/components/super/SuperNav';

export const metadata = { title: 'WORKON Super Admin' };

export default async function SuperLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  // 미들웨어가 설정한 x-pathname 헤더로 로그인 페이지 감지
  const headersList = headers();
  const pathname = headersList.get('x-pathname') ?? '';
  if (pathname === '/super/login') {
    return <>{children}</>;
  }

  // 나머지 /super/* 페이지: 세션 검증
  const session = await getSuperAdminSession();
  if (!session) {
    redirect('/super/login');
  }

  return (
    <div className="flex h-screen bg-[#0F172A] overflow-hidden">

      {/* 헤더 */}
      <div className="fixed top-0 left-0 right-0 z-40 h-12 bg-[#0F172A] border-b border-slate-800 flex items-center px-5 gap-3">
        <div className="flex items-center gap-2">
          <span className="text-base">🔐</span>
          <span className="text-sm font-bold text-white tracking-tight">WORKON SUPER ADMIN</span>
        </div>
        <div className="flex-1" />
        <div className="flex items-center gap-2">
          <span className="px-2.5 py-1 bg-[#7C3AED]/20 border border-[#7C3AED]/30 rounded-full text-[10px] font-bold text-[#A78BFA] uppercase tracking-wider">
            SUPER ADMIN
          </span>
          <span className="text-xs text-slate-400">{session.email}</span>
        </div>
      </div>

      {/* 사이드바 + 콘텐츠 */}
      <div className="flex flex-1 pt-12 overflow-hidden">
        <SuperNav adminName={session.name} adminEmail={session.email} />

        <main className="flex-1 overflow-y-auto bg-[#0F172A]">
          <div className="p-8">
            {children}
          </div>
        </main>
      </div>
    </div>
  );
}
