import { validateAppDefinition, renderAppInput } from './definition';
import { restoreAppSteps } from './resume';
import { appStepsCompleted, type AppStepRecord } from './pipeline';
export type AppHistoryStatus = 'saved' | 'interrupted' | 'no_response' | 'uncertain';
export type AppHistoryItem = { id: string; agentId: string; appName: string; title: string; createdAt: string; status: AppHistoryStatus; preview: string; messageId: string | null; version: number | null; canResume: boolean; steps: AppStepRecord[] };
export const HISTORY_PAGE_SIZE = 20;
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export function encodeHistoryCursor(at: string, id: string): string { return Buffer.from(JSON.stringify({ at, id })).toString('base64url'); }
export function decodeHistoryCursor(raw: string): { at: string; id: string } | null {
  if (raw.length > 512) return null;
  try {
    const data = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8'));
    if (typeof data?.id !== 'string' || !uuid.test(data.id) || typeof data.at !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?(?:Z|[+-]\d{2}:\d{2})$/.test(data.at) || !Number.isFinite(Date.parse(data.at))) return null;
    const day = data.at.slice(0, 10);
    if (Number(day.slice(0, 4)) < 1 || new Date(`${day}T00:00:00Z`).toISOString().slice(0, 10) !== day) return null;
    return { at: data.at, id: data.id };
  } catch { return null; }
}

export function historySummary(row: { id: string; agent_id: string; title: string; created_at: string; agent: { name: string; version: number; app_definition: unknown; capabilities: unknown }; messages: { id: string; content: string; agent_version: number | null; source_references: Record<string, unknown> | null }[] }): AppHistoryItem {
  const message = row.messages[0]; const refs = message?.source_references ?? {};
  const raw = Array.isArray(refs.app_steps) ? refs.app_steps : [];
  let status: AppHistoryStatus = !message?.content?.trim() ? 'no_response' : 'saved';
  if (raw.length) status = raw.some(step => step?.status === 'failed' || step?.status === 'not_run') ? 'interrupted' : appStepsCompleted(raw) ? 'saved' : 'uncertain';
  const definition = validateAppDefinition(row.agent.app_definition);
  let canResume = false;
  if (status === 'interrupted' && definition.ok && definition.value && message.agent_version === row.agent.version && Object.keys(row.agent.capabilities ?? {}).length === 0) {
    const input = renderAppInput(definition.value, refs.app_inputs);
    canResume = input.ok && restoreAppSteps(definition.value, refs, input.message).ok;
  }
  const steps: AppStepRecord[] = raw.slice(0, 3).filter(step => step && typeof step.name === 'string' && ['pending', 'running', 'completed', 'skipped', 'failed', 'not_run'].includes(step.status)).map(step => ({ name: step.name.slice(0, 40), status: step.status, ...(step.reused === true ? { reused: true } : {}) }));
  return { id: row.id, agentId: row.agent_id, appName: row.agent.name, title: row.title, createdAt: row.created_at, status, preview: (message?.content ?? '').replace(/\s+/g, ' ').slice(0, 160), messageId: message?.id ?? null, version: message?.agent_version ?? null, canResume, steps };
}
