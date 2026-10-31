import { NextRequest, NextResponse } from 'next/server';
import { getServerAuthSession } from '@/lib/auth';
import { getActorScope } from '@/lib/actor-scope';
import { supabaseAdmin } from '@/lib/supabaseAdmin';
import { AGENT_ACCESS_COLUMNS, canUseAgent, type AgentAccessInfo } from '@/lib/agent-permissions';
import { HISTORY_PAGE_SIZE, decodeHistoryCursor, encodeHistoryCursor, historySummary } from '@/lib/apps/history';
export const dynamic = 'force-dynamic';
const fail = (message: string, status: number) => NextResponse.json({ ok: false, error: { message } }, { status });
export async function GET(request: NextRequest) {
  const session = await getServerAuthSession();
  if (!session?.user?.id) return fail('인증이 필요합니다.', 401);
  const actor = await getActorScope(session);
  if (!actor?.organizationId) return fail('기관 소속을 확인할 수 없습니다.', 403);
  const cursorText = request.nextUrl.searchParams.get('cursor');
  const cursor = cursorText ? decodeHistoryCursor(cursorText) : null;
  const agentId = request.nextUrl.searchParams.get('agent');
  if ((cursorText && !cursor) || (agentId && !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(agentId))) return fail('기록 조회 조건을 확인해 주세요.', 400);
  let query = supabaseAdmin.from('conversations').select(`id,title,agent_id,created_at,agent:agents!inner(${AGENT_ACCESS_COLUMNS},name,app_definition,capabilities),messages(id,content,agent_version,source_references)`)
    .eq('user_id', session.user.id).eq('agent.organization_id', actor.organizationId).not('agent.app_definition', 'is', null)
    .eq('messages.role', 'assistant').order('created_at', { ascending: false }).order('id', { ascending: false })
    .order('created_at', { referencedTable: 'messages', ascending: false }).order('id', { referencedTable: 'messages', ascending: false }).limit(1, { referencedTable: 'messages' }).limit(HISTORY_PAGE_SIZE + 1);
  if (agentId) query = query.eq('agent_id', agentId);
  if (cursor) query = query.or(`created_at.lt.${cursor.at},and(created_at.eq.${cursor.at},id.lt.${cursor.id})`);
  const { data, error } = await query;
  if (error) return fail('앱 기록을 불러오지 못했습니다.', 503);
  type SummaryRow = Parameters<typeof historySummary>[0];
  type RawRow = Omit<SummaryRow, 'agent'> & { agent: (SummaryRow['agent'] & AgentAccessInfo) | (SummaryRow['agent'] & AgentAccessInfo)[] };
  const rows = (data ?? []) as RawRow[]; const page = rows.slice(0, HISTORY_PAGE_SIZE);
  const items = page.flatMap(row => {
    const agent = Array.isArray(row.agent) ? row.agent[0] : row.agent;
    if (!agent || !canUseAgent(agent, actor)) return [];
    return [historySummary({ ...row, agent, messages: row.messages ?? [] })];
  });
  const last = page[page.length - 1];
  return NextResponse.json({ ok: true, data: { items, nextCursor: rows.length > HISTORY_PAGE_SIZE && last ? encodeHistoryCursor(last.created_at, last.id) : null } });
}
