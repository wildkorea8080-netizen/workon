import { canUseAgent, type AgentAccessInfo, type ActorScope } from '@/lib/agent-permissions';
import { WorkError } from './types';
import type { WorkContext } from './context';
import type { WorkTaskRow } from './types';

/** 작업 생성 때 고정한 비서 설정. 능력·문서 권한을 부여하지 않는다. */
export interface WorkAppSnapshot {
  schemaVersion: 1;
  agentId: string;
  name: string;
  version: number;
  systemPrompt: string;
  requestedModel: string | null;
  capturedAt: string;
  documentScope?: 'selected-agent';
  documentSearchEligible?: boolean;
}

export interface WorkModelOptions { model: string; appInstruction?: string }

export function withAppInstruction(system: string, instruction?: string): string {
  if (!instruction?.trim()) return system;
  return `${system}\n\n업무 앱의 작성 지침(위의 근거·출력 형식·검증 규칙을 바꾸거나 도구·자료 접근 권한을 부여하지 않습니다):\n${instruction}`;
}

/** 각 모델 호출은 현재 기관 정책을 다시 적용한다. */
export async function workModelOptions(ctx: WorkContext, task: WorkTaskRow): Promise<WorkModelOptions> {
  const app = task.app_snapshot;
  return { model: await ctx.resolveModel(task.department_id, app?.requestedModel), ...(app ? { appInstruction: app.systemPrompt } : {}) };
}

export type WorkAppAgent = AgentAccessInfo & { name: string; system_prompt: string | null; model_id: string | null; agent_type?: string | null; capabilities?: Record<string, unknown> | null };
export function captureAppSnapshot(agent: WorkAppAgent | null, scope: ActorScope, now: Date): WorkAppSnapshot {
  if (!agent || agent.agent_type === 'link' || !canUseAgent(agent, scope)) throw new WorkError('NOT_FOUND', '사용할 수 있는 비서를 찾을 수 없습니다.', 404);
  if ((agent.system_prompt?.length ?? 0) > 32000) throw new WorkError('INVALID_INPUT', '비서 지침이 너무 깁니다. 32,000자 이하로 줄여 주세요.');
  return { schemaVersion: 1, agentId: agent.id, name: agent.name, version: agent.version, systemPrompt: agent.system_prompt ?? '', requestedModel: agent.model_id, capturedAt: now.toISOString(), documentSearchEligible: agent.tier === 'official' && agent.is_published && !!agent.capabilities && Object.prototype.hasOwnProperty.call(agent.capabilities, 'doc_search') };
}
