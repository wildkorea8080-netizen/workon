import Shell from '@/components/Shell';
import { getServerAuthSession, isAdminSession } from '@/lib/auth';
import StatsDashboard from '@/components/admin/StatsDashboard';
import UsageSummary from '@/components/admin/UsageSummary';

export default async function AdminStatsPage() {
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
          <h1 className="text-3xl font-semibold">통계</h1>
          <p className="text-slate-600 mt-2">부서의 사용량과 성능 통계를 확인합니다.</p>
        </div>

        <StatsDashboard />

        <div className="pt-2">
          <h2 className="text-lg font-semibold text-slate-900">이용통계</h2>
          <p className="text-sm text-slate-500 mt-0.5 mb-4">
            비서별·직원별·부서별 사용량입니다. 조회 범위는 내 부서와 하위 부서입니다.
          </p>
          <UsageSummary />
        </div>
      </section>
    </Shell>
  );
}