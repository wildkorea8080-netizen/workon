import { getServerAuthSession } from '@/lib/auth';
import ReportWizard from '@/components/report/ReportWizard';

export default async function ReportPage() {
  const session = await getServerAuthSession();

  if (!session?.user?.id) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <div className="text-center">
          <h1 className="text-2xl font-semibold text-red-600">접근 거부</h1>
          <p className="text-slate-600 mt-2">로그인이 필요합니다.</p>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-slate-50">
      <div className="max-w-4xl mx-auto px-4 py-8">
        <div className="mb-8">
          <h1 className="text-3xl font-semibold text-slate-900">보고서 생성</h1>
          <p className="text-slate-600 mt-2">템플릿을 선택하여 맞춤 보고서를 생성합니다.</p>
        </div>

        <ReportWizard />
      </div>
    </div>
  );
}