import { getServerAuthSession, isAdminSession } from '@/lib/auth';
import Link from 'next/link';

export default async function AdminLayout({ children }: { children: React.ReactNode }) {
  const session = await getServerAuthSession();
  const isAdmin = isAdminSession(session);

  if (!isAdmin) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-slate-50">
        <div className="text-center">
          <h1 className="text-2xl font-semibold text-red-600">접근 거부</h1>
          <p className="text-slate-600 mt-2">관리자 권한이 필요합니다.</p>
          <Link href="/" className="inline-block mt-4 px-4 py-2 bg-slate-900 text-white rounded-lg hover:bg-slate-800">
            돌아가기
          </Link>
        </div>
      </div>
    );
  }

  return (
    <div className="flex h-screen bg-slate-50">
      {/* 좌측 사이드바 */}
      <aside className="w-60 bg-blue-900 text-white flex flex-col">
        {/* 헤더 */}
        <div className="p-6 border-b border-blue-800">
          <Link href="/admin" className="text-xl font-bold hover:text-blue-200">
            관리자 포털
          </Link>
          <p className="text-xs text-blue-300 mt-2">WORKON v0.1</p>
        </div>

        {/* 메뉴 */}
        <nav className="flex-1 p-4 overflow-y-auto">
          <div className="space-y-2">
            <AdminMenuLink href="/admin" label="📊 대시보드" />
            <AdminMenuLink href="/admin/agents" label="⚡ 비서 관리" />
            <AdminMenuLink href="/admin/documents" label="📄 문서 관리" />
            <AdminMenuLink href="/admin/users" label="👥 사용자 관리" />
            <AdminMenuLink href="/admin/templates" label="🎯 AI 프롬프트" />
            <AdminMenuLink href="/admin/stats" label="📈 사용량 통계" />
            <AdminMenuLink href="/admin/settings" label="⚙️ 설정" />
          </div>
        </nav>

        {/* 하단 */}
        <div className="p-4 border-t border-blue-800">
          <div className="text-xs text-blue-200 mb-3">
            <p className="font-semibold">{session?.user?.email}</p>
            <p className="text-blue-300 mt-1">{session?.user?.role === 'ADMIN' ? '관리자' : '사용자'}</p>
          </div>
          <Link
            href="/"
            className="block w-full px-4 py-2 text-sm text-center bg-blue-800 hover:bg-blue-700 rounded-lg transition"
          >
            메인 화면
          </Link>
        </div>
      </aside>

      {/* 우측 콘텐츠 */}
      <div className="flex-1 flex flex-col overflow-hidden">
        {/* 상단 헤더 */}
        <header className="bg-white border-b border-slate-200 px-8 py-4">
          <h1 className="text-lg font-semibold text-slate-900">관리자 패널</h1>
        </header>

        {/* 메인 콘텐츠 */}
        <main className="flex-1 overflow-y-auto px-8 py-6">
          {children}
        </main>
      </div>
    </div>
  );
}

function AdminMenuLink({ href, label }: { href: string; label: string }) {
  return (
    <Link
      href={href}
      className="flex items-center px-4 py-3 rounded-lg text-blue-100 hover:bg-blue-800 transition text-sm"
    >
      {label}
    </Link>
  );
}
