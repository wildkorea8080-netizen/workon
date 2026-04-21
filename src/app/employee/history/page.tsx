import Shell from '@/components/Shell';
import ConversationHistory from '@/components/employee/ConversationHistory';

export default function EmployeeHistoryPage() {
  return (
    <Shell>
      <section className="space-y-4">
        <div>
          <h1 className="text-3xl font-semibold">대화 히스토리</h1>
          <p className="text-slate-600 mt-2">AI 비서와 나눈 대화 목록을 확인하세요.</p>
        </div>
        <ConversationHistory />
      </section>
    </Shell>
  );
}
