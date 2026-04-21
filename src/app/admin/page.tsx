import Link from 'next/link';
import Shell from '@/components/Shell';
import { getServerAuthSession, isAdminSession } from '@/lib/auth';
import StatsDashboard from '@/components/admin/StatsDashboard';
import QuickStats from '@/components/admin/QuickStats';

export default async function AdminDashboardPage() {
  const session = await getServerAuthSession();
  const isAdmin = isAdminSession(session);

  if (!isAdmin) {
    return (
      <Shell>
        <div className="text-center py-8">
          <h1 className="text-2xl font-semibold text-red-600">접근 거부</h1>
          <p className="text-slate-600 mt-2">관리자 권한이 필요합니다.</p>
        </div>
      </Shell>
    );
  }

  return (
    <Shell>
      <section className="space-y-6">
        <div>
          <h1 className="text-3xl font-semibold">관리자 대시보드</h1>
          <p className="text-slate-600 mt-2">부서 리소스 및 사용자 관리를 위한 관리자 포털입니다.</p>
        </div>

        {/* Quick Stats */}
        <QuickStats />

        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          <Link
            href="/admin/agents"
            className="p-6 border rounded-lg bg-white hover:bg-slate-50 transition-all duration-200 hover:shadow-md group"
          >
            <div className="flex items-center space-x-3">
              <div className="w-10 h-10 bg-blue-100 rounded-lg flex items-center justify-center group-hover:bg-blue-200 transition-colors">
                <svg className="w-5 h-5 text-blue-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9.75 17L9 20l-1 1h8l-1-1-.75-3M3 13h18M5 17h14a2 2 0 002-2V5a2 2 0 00-2-2H5a2 2 0 00-2 2v10a2 2 0 002 2z" />
                </svg>
              </div>
              <div>
                <h3 className="text-lg font-medium text-slate-900">에이전트 관리</h3>
                <p className="text-sm text-slate-600 mt-1">AI 에이전트 생성 및 설정</p>
              </div>
            </div>
          </Link>

          <Link
            href="/admin/users"
            className="p-6 border rounded-lg bg-white hover:bg-slate-50 transition-all duration-200 hover:shadow-md group"
          >
            <div className="flex items-center space-x-3">
              <div className="w-10 h-10 bg-green-100 rounded-lg flex items-center justify-center group-hover:bg-green-200 transition-colors">
                <svg className="w-5 h-5 text-green-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4.354a4 4 0 110 5.292M15 21H3v-1a6 6 0 0112 0v1zm0 0h6v-1a6 6 0 00-9-5.197m13.5-9a2.5 2.5 0 11-5 0 2.5 2.5 0 015 0z" />
                </svg>
              </div>
              <div>
                <h3 className="text-lg font-medium text-slate-900">사용자 관리</h3>
                <p className="text-sm text-slate-600 mt-1">부서 사용자 및 권한 관리</p>
              </div>
            </div>
          </Link>

          <Link
            href="/admin/documents"
            className="p-6 border rounded-lg bg-white hover:bg-slate-50 transition-all duration-200 hover:shadow-md group"
          >
            <div className="flex items-center space-x-3">
              <div className="w-10 h-10 bg-purple-100 rounded-lg flex items-center justify-center group-hover:bg-purple-200 transition-colors">
                <svg className="w-5 h-5 text-purple-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
                </svg>
              </div>
              <div>
                <h3 className="text-lg font-medium text-slate-900">문서 관리</h3>
                <p className="text-sm text-slate-600 mt-1">업로드된 문서 및 청크 관리</p>
              </div>
            </div>
          </Link>

          <Link
            href="/admin/stats"
            className="p-6 border rounded-lg bg-white hover:bg-slate-50 transition-all duration-200 hover:shadow-md group"
          >
            <div className="flex items-center space-x-3">
              <div className="w-10 h-10 bg-orange-100 rounded-lg flex items-center justify-center group-hover:bg-orange-200 transition-colors">
                <svg className="w-5 h-5 text-orange-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 19v-6a2 2 0 00-2-2H5a2 2 0 00-2 2v6a2 2 0 002 2h2a2 2 0 002-2zm0 0V9a2 2 0 012-2h2a2 2 0 012 2v10m-6 0a2 2 0 002 2h2a2 2 0 002-2m0 0V5a2 2 0 012-2h2a2 2 0 012 2v14a2 2 0 01-2 2h-2a2 2 0 01-2-2z" />
                </svg>
              </div>
              <div>
                <h3 className="text-lg font-medium text-slate-900">통계</h3>
                <p className="text-sm text-slate-600 mt-1">사용량 및 성능 통계</p>
              </div>
            </div>
          </Link>

          <Link
            href="/admin/settings"
            className="p-6 border rounded-lg bg-white hover:bg-slate-50 transition-all duration-200 hover:shadow-md group"
          >
            <div className="flex items-center space-x-3">
              <div className="w-10 h-10 bg-red-100 rounded-lg flex items-center justify-center group-hover:bg-red-200 transition-colors">
                <svg className="w-5 h-5 text-red-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.065 2.572c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.572 1.065c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.065-2.572c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z" />
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
                </svg>
              </div>
              <div>
                <h3 className="text-lg font-medium text-slate-900">설정</h3>
                <p className="text-sm text-slate-600 mt-1">부서 설정 및 금지어 관리</p>
              </div>
            </div>
          </Link>

          <Link
            href="/admin/templates"
            className="p-6 border rounded-lg bg-white hover:bg-slate-50 transition-all duration-200 hover:shadow-md group"
          >
            <div className="flex items-center space-x-3">
              <div className="w-10 h-10 bg-cyan-100 rounded-lg flex items-center justify-center group-hover:bg-cyan-200 transition-colors">
                <svg className="w-5 h-5 text-cyan-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 10V3L4 14h7v7l9-11h-7z" />
                </svg>
              </div>
              <div>
                <h3 className="text-lg font-medium text-slate-900">AI 프롬프트 & 템플릿</h3>
                <p className="text-sm text-slate-600 mt-1">에이전트 프롬프트 및 보고서 템플릿 관리</p>
              </div>
            </div>
          </Link>

          <Link
            href="/admin/logs"
            className="p-6 border rounded-lg bg-white hover:bg-slate-50 transition-all duration-200 hover:shadow-md group"
          >
            <div className="flex items-center space-x-3">
              <div className="w-10 h-10 bg-gray-100 rounded-lg flex items-center justify-center group-hover:bg-gray-200 transition-colors">
                <svg className="w-5 h-5 text-gray-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 6.253v13m0-13C10.832 5.477 9.246 5 7.5 5S4.168 5.477 3 6.253v13C4.168 18.477 5.754 18 7.5 18s3.332.477 4.5 1.253m0-13C13.168 5.477 14.754 5 16.5 5c1.746 0 3.332.477 4.5 1.253v13C19.832 18.477 18.246 18 16.5 18c-1.746 0-3.332.477-4.5 1.253" />
                </svg>
              </div>
              <div>
                <h3 className="text-lg font-medium text-slate-900">사용 로그</h3>
                <p className="text-sm text-slate-600 mt-1">시스템 활동 로그</p>
              </div>
            </div>
          </Link>
        </div>
      </section>
    </Shell>
  );
}
