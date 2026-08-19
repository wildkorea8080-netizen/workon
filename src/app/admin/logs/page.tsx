import { getServerAuthSession, isAdminSession } from '@/lib/auth';

export default async function AdminLogsPage() {
  const session = await getServerAuthSession();
  const isAdmin = isAdminSession(session);

  if (!isAdmin) {
    return (
      <div className="text-center py-8">
        <h1 className="text-2xl font-semibold text-red-600">접근 거부</h1>
        <p className="text-slate-600 mt-2">관리자 권한이 필요합니다.</p>
      </div>
    );
  }

  return (
    <section className="space-y-4">
      <h1 className="text-2xl font-semibold text-slate-900">사용 로그</h1>
      <p className="text-slate-600">조직 활동을 검토하기 위한 기본 로그 뷰어 자리 표시자입니다.</p>
    </section>
  );
}
