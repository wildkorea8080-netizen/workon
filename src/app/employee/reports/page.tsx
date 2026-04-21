import Shell from '@/components/Shell';
import ReportWizard from '@/components/report/ReportWizard';

export default function EmployeeReportsPage() {
  return (
    <Shell>
      <section className="space-y-4">
        <div>
          <h1 className="text-3xl font-semibold">보고서 생성</h1>
          <p className="text-slate-600 mt-2">템플릿을 선택하고 AI로 보고서를 생성하세요.</p>
        </div>
        <ReportWizard />
      </section>
    </Shell>
  );
}
