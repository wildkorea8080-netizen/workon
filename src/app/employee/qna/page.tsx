import Shell from '@/components/Shell';
import Link from 'next/link';

export default function EmployeeQnAPage() {
  return (
    <Shell>
      <section className="space-y-4">
        <div>
          <h1 className="text-3xl font-semibold">AI 문서 Q&A</h1>
          <p className="text-slate-600 mt-2">AI 에이전트에게 내부 문서에 관한 질문을 하세요.</p>
        </div>
        <div className="p-8 text-center bg-white rounded-xl border border-slate-100">
          <p className="text-slate-500 mb-4">메인 화면에서 비서를 선택해 대화를 시작하세요.</p>
          <Link href="/" className="text-brand-600 font-medium hover:underline">메인으로 이동 →</Link>
        </div>
      </section>
    </Shell>
  );
}
