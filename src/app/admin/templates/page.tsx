import { getServerAuthSession, isAdminSession } from '@/lib/auth';
import PromptTemplateManager from '@/components/admin/PromptTemplateManager';

export default async function AdminTemplatesPage() {
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
        <h1 className="text-2xl font-semibold text-slate-900">옛 보고서 템플릿</h1>
        <p className="text-slate-600 mt-2">보고서 생성 기능은 비서로 옮겨졌습니다. 남은 템플릿 내용을 읽기 전용으로 보여 주며, 복사해 비서 지시문에 옮길 수 있습니다.</p>
      </div>
      <PromptTemplateManager />
    </section>
  );
}
