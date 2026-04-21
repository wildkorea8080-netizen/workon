import Shell from '@/components/Shell';
import { getServerAuthSession, isAdminSession } from '@/lib/auth';
import UsersManager from '@/components/admin/UsersManager';

export default async function AdminUsersPage() {
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
          <h1 className="text-3xl font-semibold">사용자 관리</h1>
          <p className="text-slate-600 mt-2">부서 사용자를 관리하고 권한을 설정합니다.</p>
        </div>

        <UsersManager />
      </section>
    </Shell>
  );
}