import { getServerAuthSession, isAdminSession } from '@/lib/auth';
import Link from 'next/link';
import AdminNav from '@/components/admin/AdminNav';
import ImpersonateBanner from '@/components/admin/ImpersonateBanner';

export default async function AdminLayout({ children }: { children: React.ReactNode }) {
  const session = await getServerAuthSession();
  const isAdmin = isAdminSession(session);

  if (!isAdmin) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-slate-50">
        <div className="text-center">
          <h1 className="text-2xl font-semibold text-red-600">접근 거부</h1>
          <p className="text-slate-600 mt-2">관리자 권한이 필요합니다.</p>
          <Link href="/" className="inline-block mt-4 px-4 py-2 bg-brand-600 text-white rounded-xl hover:bg-brand-700">
            돌아가기
          </Link>
        </div>
      </div>
    );
  }

  const isImpersonating = session?.user?.isImpersonating === true;
  const orgName = session?.user?.impersonateOrgName ?? '';

  return (
    <div className="flex h-screen bg-slate-50">
      {/* 대리 접근 배너 */}
      {isImpersonating && <ImpersonateBanner orgName={orgName} />}

      {/* 좌측 사이드바 */}
      <aside className={`w-60 bg-[#1C2B4A] text-white flex flex-col flex-shrink-0 ${isImpersonating ? 'mt-[52px]' : ''}`}>
        {/* 로고 */}
        <div className="px-6 py-5 border-b border-white/10">
          <Link href="/admin" className="flex items-center gap-2 hover:opacity-80 transition-opacity">
            <span className="text-lg">🏛️</span>
            <div>
              <p className="text-sm font-bold text-white leading-tight">AI 업무도우미</p>
              <p className="text-[10px] text-white/40 mt-0">관리자 포털{isImpersonating ? ' (대리)' : ''}</p>
            </div>
          </Link>
        </div>

        <AdminNav />

        {/* 하단 사용자 정보 */}
        <div className="px-4 py-4 border-t border-white/10">
          <div className="flex items-center gap-2.5 mb-3">
            <div className={`w-7 h-7 rounded-lg flex items-center justify-center text-white text-xs font-bold flex-shrink-0 ${isImpersonating ? 'bg-amber-500' : 'bg-brand-600'}`}>
              {session?.user?.email?.[0]?.toUpperCase() ?? 'A'}
            </div>
            <div className="min-w-0">
              <p className="text-xs font-semibold text-white truncate">{session?.user?.email}</p>
              <p className={`text-[11px] ${isImpersonating ? 'text-amber-400' : 'text-white/40'}`}>
                {isImpersonating ? '대리 접근 중' : '관리자'}
              </p>
            </div>
          </div>
          <Link
            href="/"
            className="flex items-center justify-center gap-2 w-full px-3 py-2 text-xs font-medium bg-white/10 hover:bg-white/20 rounded-lg transition-colors text-white/80"
          >
            <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10 19l-7-7m0 0l7-7m-7 7h18" />
            </svg>
            메인 화면
          </Link>
        </div>
      </aside>

      {/* 우측 콘텐츠 */}
      <div className={`flex-1 flex flex-col overflow-hidden ${isImpersonating ? 'mt-[52px]' : ''}`}>
        <main className="flex-1 overflow-y-auto px-8 py-6">
          {children}
        </main>
      </div>
    </div>
  );
}
