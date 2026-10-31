import type { Agent } from '@/lib/db';
import type { WorkflowSummaryDto } from '@/components/work/types';

export function taskAgentChoices(rows: Agent[]): Agent[] {
  return [...new Map(rows.filter((a) => a.is_active && !a.deleted_at && a.agent_type !== 'link').map((a) => [a.id, a])).values()];
}

const WORK_LAUNCHES = [ ['regulations', '규정 확인'], ['report', '보고서 작성'], ['reply', '민원 회신'] ] as const;
/** 권한 API의 목록만 사용한다. 링크 이동은 작업이나 모델 호출을 생성하지 않는다. */
export function workLaunchLinks(agent: Agent | undefined, workflows: WorkflowSummaryDto[], enabled: boolean) {
  if (!agent || !enabled || !taskAgentChoices([agent]).length) return [];
  return WORK_LAUNCHES.filter(([key]) => workflows.some((w) => w.key === key && w.available)).map(([key, label]) => ({
    label, href: `/tasks/new?workflow=${key}&agent=${encodeURIComponent(agent.id)}`,
  }));
}
