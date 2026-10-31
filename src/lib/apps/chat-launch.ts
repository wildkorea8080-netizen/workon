import type { Agent } from '@/lib/db';

export function chatLaunchTarget(params: { get(name: string): string | null }): { kind: 'conversation' | 'agent'; id: string } | null {
  const conversation = params.get('conv');
  if (conversation) return { kind: 'conversation', id: conversation };
  const agent = params.get('agent');
  return agent ? { kind: 'agent', id: agent } : null;
}

/** GET /agents/[id] is editor-only. Resolve launches through the ordinary visible and personal lists instead. */
export async function loadChatLaunchAgent(id: string, request: typeof fetch = fetch): Promise<Agent | null> {
  const results = await Promise.allSettled(['/api/agents', '/api/agents?personal=true'].map(async (url) => {
    const response = await request(url);
    const body = await response.json();
    if (!response.ok || !body.ok || !Array.isArray(body.data)) throw new Error('비서 목록을 불러오지 못했습니다.');
    return body.data as Agent[];
  }));
  const agent = results.flatMap((result) => result.status === 'fulfilled' ? result.value : [])
    .find((a) => a.id === id && a.is_active && !a.deleted_at && a.agent_type !== 'link');
  if (agent) return agent;
  if (results.some((result) => result.status === 'rejected')) throw new Error('비서 목록을 불러오지 못했습니다.');
  return null;
}
