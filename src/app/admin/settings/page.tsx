import { getServerAuthSession, isAdminSession } from '@/lib/auth';
import SettingsManager from '@/components/admin/SettingsManager';
import SharedLinksPanel from '@/components/admin/SharedLinksPanel';

export default async function AdminSettingsPage() {
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
    <section className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold text-slate-900">설정</h1>
        <p className="text-slate-600 mt-2">금지어, 보안 이벤트 로그, 직원이 공개 링크로 공유 중인 대화를 관리합니다.</p>
      </div>

      <SettingsManager />

      {/* 직원이 로그인 없이 볼 수 있는 링크로 공유한 대화 — 기관이 알고 멈출 수 있게(2026-11-18) */}
      <SharedLinksPanel />
    </section>
  );
}