import type { Agent } from '@/lib/db';
import { renderAppInput } from './definition';
import { restoreAppSteps } from './resume';
import type { AppStepRecord } from './pipeline';
export type AppResumeSource = { id: string; conversationId: string; inputs: Record<string, string>; records: AppStepRecord[] };

/** Read-only prefill. The execution endpoint rechecks every condition independently. */
export async function loadAppResumeSource(agent: Agent, conversationId: string, messageId?: string, request: typeof fetch = fetch): Promise<AppResumeSource | null> {
  if (!agent.app_definition) return null;
  const response = await request(`/api/conversations/${encodeURIComponent(conversationId)}`, { cache: 'no-store' });
  const body = await response.json().catch(() => null);
  if (!response.ok || !body?.ok || body.data?.agent_id !== agent.id || !Array.isArray(body.data?.messages)) return null;
  for (const message of [...body.data.messages].reverse()) {
    if (message.role !== 'assistant' || (messageId && message.id !== messageId) || message.agent_version !== agent.version || typeof message.id !== 'string') continue;
    const refs = message.source_references ?? {};
    const input = renderAppInput(agent.app_definition, refs.app_inputs);
    if (!input.ok || !restoreAppSteps(agent.app_definition, refs, input.message).ok) continue;
    const records = (refs.app_steps as AppStepRecord[]).map(step => ({ name: step.name, status: step.status, ...(step.status === 'completed' ? { output: step.output, reused: step.reused === true } : {}) }));
    return { id: message.id, conversationId, inputs: input.inputs, records };
  }
  return null;
}
