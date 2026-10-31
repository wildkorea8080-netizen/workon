import { NextRequest, NextResponse } from 'next/server';
import { getServerAuthSession } from '@/lib/auth';
import { getActorScope } from '@/lib/actor-scope';
import { supabaseAdmin } from '@/lib/supabaseAdmin';
import { AGENT_ACCESS_COLUMNS, canUseAgent } from '@/lib/agent-permissions';
import { isWorkflowKey } from '@/lib/work/catalog';

export const dynamic = 'force-dynamic';
const error = (message: string, status: number) => NextResponse.json({ ok: false, error: { message } }, { status });

export async function GET() {
  const session = await getServerAuthSession();
  if (!session?.user?.id) return error('인증이 필요합니다.', 401);
  const { data, error: failure } = await supabaseAdmin.from('users').select('favorite_agent_ids, favorite_workflow_keys').eq('id', session.user.id).maybeSingle();
  if (failure) return error('즐겨찾기를 불러오지 못했습니다.', 503);
  if (!data) return error('사용자를 찾을 수 없습니다.', 404);
  return NextResponse.json({ ok: true, data: { agentIds: data.favorite_agent_ids ?? [], workflowKeys: data.favorite_workflow_keys ?? [] } });
}

export async function POST(request: NextRequest) {
  const session = await getServerAuthSession();
  if (!session?.user?.id) return error('인증이 필요합니다.', 401);
  let body;
  try { body = await request.json(); } catch { return error('요청 형식이 올바르지 않습니다.', 400); }
  if (!body || typeof body.appId !== 'string' || body.appId.length > 110 || typeof body.favorite !== 'boolean') return error('앱과 즐겨찾기 상태를 확인해 주세요.', 400);
  const actor = await getActorScope(session);
  if (!actor?.organizationId) return error('기관 소속을 확인할 수 없습니다.', 403);
  const [kind, key, extra] = body.appId.split(':');
  if (extra !== undefined || !key || !['agent', 'workflow'].includes(kind)) return error('앱 형식이 올바르지 않습니다.', 400);
  if (kind === 'workflow') {
    if (!isWorkflowKey(key)) return error('업무 앱을 찾을 수 없습니다.', 404);
  } else {
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(key)) return error('비서 형식이 올바르지 않습니다.', 400);
    // Removing a stale favorite is allowed; adding one always rechecks current access.
    if (body.favorite) {
      const { data, error: failure } = await supabaseAdmin.from('agents').select(AGENT_ACCESS_COLUMNS).eq('id', key).maybeSingle();
      if (failure) return error('비서 권한을 확인하지 못했습니다.', 503);
      if (!data || !canUseAgent(data, actor)) return error('사용할 수 없는 비서입니다.', 403);
    }
  }
  const { data, error: failure } = await supabaseAdmin.rpc('set_user_app_favorite', { p_user_id: session.user.id, p_kind: kind, p_key: key, p_favorite: body.favorite });
  if (failure) return error(failure.code === '22023' ? '즐겨찾기는 종류별 최대 200개까지 등록할 수 있습니다.' : '즐겨찾기를 저장하지 못했습니다.', failure.code === '22023' ? 400 : 503);
  return NextResponse.json({ ok: true, data });
}
