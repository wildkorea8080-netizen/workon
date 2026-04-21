import Shell from '@/components/Shell';
import { getServerAuthSession, isAdminSession } from '@/lib/auth';
import StatsDashboard from '@/components/admin/StatsDashboard';

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
      </section>
    </Shell>
  );
}