import Link from 'next/link';
import type { AppStepRecord } from '@/lib/apps/pipeline';
export default function AppResumeLink({ agentId, conversationId, messageId, steps, inputs }: { agentId: string; conversationId: string; messageId: string; steps?: AppStepRecord[]; inputs?: Record<string, string> }) {
  if (!inputs || !steps?.some(step => step.status === 'completed') || !steps.some(step => step.status === 'failed')) return null;
  return <Link href={`/apps/run?agent=${encodeURIComponent(agentId)}&from=${encodeURIComponent(conversationId)}&resume=${encodeURIComponent(messageId)}`} className="my-3 inline-block rounded-xl border border-[#087f8c] px-4 py-2 text-sm font-semibold text-[#087581]">완료된 단계부터 이어서 실행</Link>;
}
