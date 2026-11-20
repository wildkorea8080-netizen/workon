import { NextRequest, NextResponse } from 'next/server';
import { getServerAuthSession } from '@/lib/auth';
import { supabaseAdmin } from '@/lib/supabaseAdmin';
import { withoutAppDraft } from '@/lib/apps/draft';
import { getActorScope } from '@/lib/actor-scope';
import { AGENT_ACCESS_COLUMNS, canUseAgent, type AgentAccessInfo } from '@/lib/agent-permissions';

/**
 * 비서 즐겨찾기(옛 길 — 화면은 POST만 쓰고 목록은 `/api/agents?favorites=true`).
 *
 * 2026-11-06: 쓸 수 있는 비서만(`canUseAgent` — 다른 사람의 나만의 비서·지운 비서·다른 기관 비서는 안 됨).
 * 예전에는 POST가 아무 비서 id나 받아 두고, GET이 '같은 부서'의 그 비서를 칸 전부(`*` — 지시문 포함)와 함께 돌려줘
 * 같은 부서 동료의 나만의 비서 설정을 id만 알면 읽을 수 있었다. 거꾸로 다른 부서의 기관 공개 공식 비서는 즐겨찾기에 안 나왔다.
 * 빼기는 언제나 된다(이제 못 쓰는 비서를 지울 수 있게). 신식 `/api/apps/favorites`와 같은 규칙
 */
const MAX_FAVORITES = 200;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const jsonError = (message: string, status: number) =>
  NextResponse.json({ ok: false, error: { message } }, { status });

export async function GET(_request: NextRequest) {
  try {
    const session = await getServerAuthSession();
    if (!session?.user?.id) return jsonError('인증이 필요합니다.', 401);
    const actor = await getActorScope(session);
    if (!actor) return jsonError('소속 부서가 지정되지 않았습니다.', 403);

    const { data: user, error: userError } = await supabaseAdmin
      .from('users')
      .select('favorite_agent_ids')
      .eq('id', session.user.id)
      .single();
    // 못 읽으면 '사용자 없음'(404)이 아니라 그렇다고(2026-11-19) — 쓰기 전에 읽는 것이라 빈 목록으로 보면 즐겨찾기를 덮어쓴다
    if (userError) return jsonError('즐겨찾기를 지금 불러오지 못했습니다. 잠시 뒤 다시 시도해 주세요.', 503);
    if (!user) return jsonError('사용자 정보를 찾을 수 없습니다.', 404);

    const favoriteIds: string[] = user.favorite_agent_ids ?? [];
    if (favoriteIds.length === 0) return NextResponse.json({ ok: true, data: [] });

    const { data: agents, error } = await supabaseAdmin.from('agents').select('*').in('id', favoriteIds.slice(0, MAX_FAVORITES));
    if (error) return jsonError('즐겨찾기 비서 조회 중 오류가 발생했습니다.', 500);

    // 지금 쓸 수 있는 비서만 — 부서가 같다는 것만으로는 안 된다(나만의 비서는 주인만)
    const usable = ((agents ?? []) as Array<AgentAccessInfo & Record<string, unknown>>).filter((a) => canUseAgent(a, actor));
    // 목록에는 시험 판(0053)을 싣지 않는다
    return NextResponse.json({ ok: true, data: usable.map(withoutAppDraft) });
  } catch (error) {
    console.error('[favorite GET]', error);
    return jsonError('서버 오류가 발생했습니다.', 500);
  }
}

export async function POST(request: NextRequest) {
  try {
    const session = await getServerAuthSession();
    if (!session?.user?.id) return jsonError('인증이 필요합니다.', 401);

    const body = await request.json().catch(() => null);
    const agentId = body?.agentId;
    if (!agentId || typeof agentId !== 'string') return jsonError('agentId가 필요합니다.', 400);
    // 즐겨찾기 칸은 uuid 배열이다 — 다른 글은 DB가 거절해 500이 됐다
    if (!UUID.test(agentId)) return jsonError('비서 형식이 올바르지 않습니다.', 400);

    const { data: user, error: userError } = await supabaseAdmin
      .from('users')
      .select('favorite_agent_ids')
      .eq('id', session.user.id)
      .single();
    // 못 읽으면 '사용자 없음'(404)이 아니라 그렇다고(2026-11-19) — 쓰기 전에 읽는 것이라 빈 목록으로 보면 즐겨찾기를 덮어쓴다
    if (userError) return jsonError('즐겨찾기를 지금 불러오지 못했습니다. 잠시 뒤 다시 시도해 주세요.', 503);
    if (!user) return jsonError('사용자 정보를 찾을 수 없습니다.', 404);

    const current: string[] = user.favorite_agent_ids ?? [];
    const isFavorite = current.includes(agentId);

    // 더하기는 지금 쓸 수 있는 비서만. 빼기는 언제나(못 쓰게 된 비서도 지울 수 있게)
    if (!isFavorite) {
      if (current.length >= MAX_FAVORITES) return jsonError(`즐겨찾기는 ${MAX_FAVORITES}개까지 등록할 수 있습니다.`, 400);
      const actor = await getActorScope(session);
      if (!actor) return jsonError('소속 부서가 지정되지 않았습니다.', 403);
      const { data: agent, error: agentError } = await supabaseAdmin.from('agents').select(AGENT_ACCESS_COLUMNS).eq('id', agentId).maybeSingle();
      if (agentError) return jsonError('비서 권한을 확인하지 못했습니다.', 503);
      if (!agent || !canUseAgent(agent as unknown as AgentAccessInfo, actor)) return jsonError('사용할 수 없는 비서입니다.', 403);
    }

    // 행을 잠그는 DB 함수로 더하고 뺀다(0042, `/api/apps/favorites`와 같은 길 — 2026-11-19).
    // 예전엔 읽은 목록을 고쳐 통째로 저장해, 거의 동시에 다른 비서 둘을 누르면 하나가 빠졌다
    const { data: saved, error } = await supabaseAdmin.rpc('set_user_app_favorite', {
      p_user_id: session.user.id, p_kind: 'agent', p_key: agentId, p_favorite: !isFavorite,
    });
    if (error) {
      if (error.code === '22023') return jsonError(`즐겨찾기는 ${MAX_FAVORITES}개까지 등록할 수 있습니다.`, 400);
      return jsonError('즐겨찾기를 저장하지 못했습니다. 잠시 뒤 다시 시도해 주세요.', 503);
    }
    const agentIds = (saved as { agentIds?: unknown } | null)?.agentIds;
    const favoriteIds = Array.isArray(agentIds) ? agentIds.filter((v): v is string => typeof v === 'string') : [];

    return NextResponse.json({ ok: true, data: { isFavorite: !isFavorite, favoriteIds } });
  } catch (error) {
    console.error('[favorite POST]', error);
    return jsonError('서버 오류가 발생했습니다.', 500);
  }
}
