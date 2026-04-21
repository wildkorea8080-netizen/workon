import Shell from '@/components/Shell';
import ChatInterface from '@/components/chat/ChatInterface';

export default function EmployeeQnAPage() {
  return (
    <Shell>
      <section className="space-y-4">
        <div>
          <h1 className="text-3xl font-semibold">AI 문서 Q&A</h1>
          <p className="text-slate-600 mt-2">AI 에이전트에게 내부 문서에 관한 질문을 하세요.</p>
        </div>
        <ChatInterface />
      </section>
    </Shell>
  );
}
