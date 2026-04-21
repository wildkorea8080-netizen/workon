import Shell from '@/components/Shell';
import EmployeeDashboard from '@/components/employee/EmployeeDashboard';

export default function EmployeeDashboardPage() {
  return (
    <Shell>
      <section className="space-y-4">
        <div>
          <h1 className="text-3xl font-semibold">직원 대시보드</h1>
          <p className="text-slate-600 mt-2">내 사용 현황과 최근 활동을 확인하세요.</p>
        </div>
        <EmployeeDashboard />
      </section>
    </Shell>
  );
}
