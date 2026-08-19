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
        <h1 className="text-2xl font-semibold text-slate-900">AI 프롬프트 & 템플릿</h1>
        <p className="text-slate-600 mt-2">에이전트별 시스템 프롬프트와 보고서 템플릿을 관리합니다.</p>
      </div>
      <PromptTemplateManager />
    </section>
  );
}
