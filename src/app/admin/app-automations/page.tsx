import { getServerAuthSession, isAdminSession } from '@/lib/auth';
import AppAutomationAdmin from '@/components/admin/AppAutomationAdmin';
import OutboundEndpointsPanel from '@/components/admin/OutboundEndpointsPanel';

export default async function AdminAppAutomationsPage() {
  const session = await getServerAuthSession();
  if (!isAdminSession(session)) {
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
        <h1 className="text-2xl font-semibold text-slate-900">앱 예약·연동</h1>
        <p className="text-slate-600 mt-2">
          관리 범위 직원이 만든 입력형 앱 예약과 외부 시스템 연동(Webhook)입니다. 입력값·결과·토큰은 보이지 않습니다.
          연동 회수와 예약 멈춤은 사유와 함께 보안 로그에 남고, 직원 화면에도 사유가 보입니다.
        </p>
      </div>
      <AppAutomationAdmin />
      <OutboundEndpointsPanel />
    </section>
  );
}
