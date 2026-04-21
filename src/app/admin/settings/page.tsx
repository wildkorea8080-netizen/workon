import Shell from '@/components/Shell';
import { getServerAuthSession, isAdminSession } from '@/lib/auth';
import SettingsManager from '@/components/admin/SettingsManager';

export default async function AdminSettingsPage() {
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
          <h1 className="text-3xl font-semibold">설정</h1>
          <p className="text-slate-600 mt-2">부서 설정과 금지어를 관리합니다.</p>
        </div>

        <SettingsManager />
      </section>
    </Shell>
  );
}