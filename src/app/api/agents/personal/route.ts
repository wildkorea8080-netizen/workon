import { NextRequest, NextResponse } from 'next/server';
import { getServerAuthSession } from '@/lib/auth';
import { supabaseAdmin } from '@/lib/supabaseAdmin';
import { getActorScope } from '@/lib/actor-scope';
import { splitAgentBody } from '@/lib/agent-patch';
import {
  jsonError,
  knownIds,
  validateModelForOrganization,
  checkCapabilityScope,
} from '@/lib/agent-route-helpers';

/**
 * 직원이 만드는 비서 — 나만의 비서 또는 부서 비서.
 *
 * 부서 비서는 승인 없이 바로 만든다(결정 4). 주인 부서는 만든 사람의
 * 지금 부서다. 다른 부서를 고를 수 없다 — 고를 수 있으면 아무 부서에나
 * 비서를 밀어 넣을 수 있다.
 */
export async function GET(_request: NextRequest) {
  try {
    const session = await getServerAuthSession();
    if (!session?.user?.id) return jsonError('인증이 필요합니다.', 401);

    const { data: agents, error } = await supabaseAdmin
      .from('agents')
      .select('*')
      .eq('tier', 'personal')
      .eq('owner_id', session.user.id)
      .is('deleted_at', null)
      .order('created_at', { ascending: false });

    if (error) return jsonError('나만의 비서 조회 중 오류가 발생했습니다.', 500);
    return NextResponse.json({ ok: true, data: agents });
  } catch (error) {
    console.error('[personal agents GET]', error);
    return jsonError('서버 오류가 발생했습니다.', 500);
  }
}

export async function POST(request: NextRequest) {
  try {
    const session = await getServerAuthSession();
    if (!session?.user?.id) return jsonError('인증이 필요합니다.', 401);

    const actor = await getActorScope(session);
    if (!actor) return jsonError('소속 부서가 지정되지 않았습니다. 기관 관리자에게 문의하세요.', 403);

    const raw = (await request.json()) as Record<string, unknown>;
    const tier = raw.tier === 'department' ? 'department' : 'personal';

    // 옛 화면은 systemPrompt(camelCase)로 보낸다
    const { tier: _tier, systemPrompt, ...rest } = raw;
    const body: Record<string, unknown> = {
      ...rest,
      ...(systemPrompt !== undefined && rest.system_prompt === undefined ? { system_prompt: systemPrompt } : {}),
    };

    const split = splitAgentBody(body, { currentType: 'chat', ...knownIds() });
    if (split.error) return jsonError(split.error, 400);
    if (!split.settings.name) return jsonError('비서 이름은 필수입니다.', 400);
    if (Object.keys(split.operational).length > 0) {
      return jsonError('노출·공개 범위·유형은 공식 비서에서만 정할 수 있습니다.', 400);
    }

    const capabilities = split.settings.capabilities ?? { image: {} };

    const modelError = await validateModelForOrganization(split.settings.model_id, actor.organizationId);
    if (modelError) return jsonError(modelError, 400);

    // 화면에서 걸러 보내더라도 그건 표시일 뿐이다. 실제 제한은 여기서 건다.
    const scopeError = await checkCapabilityScope(tier, capabilities, actor.departmentId);
    if (scopeError) return jsonError(scopeError, 403);

    const { data: agent, error } = await supabaseAdmin
      .from('agents')
      .insert({
        department_id: actor.departmentId,
        tier,
        ...split.settings,
        capabilities,
        category: split.settings.category ?? '전체',
        owner_id: tier === 'personal' ? actor.userId : null,
        visibility: tier === 'department' ? 'department' : 'organization',
        // 부서 비서는 승인 없이 바로 쓴다. 나만의 비서는 본인만 본다.
        is_published: true,
        created_by: actor.userId,
        updated_by: actor.userId,
      })
      .select()
      .single();

    if (error) {
      if (error.code === '23505') {
        return jsonError(
          tier === 'department' ? '부서에 같은 이름의 비서가 이미 있습니다.' : '같은 이름의 비서가 이미 있습니다.',
          409
        );
      }
      return jsonError('비서 생성 중 오류가 발생했습니다.', 500);
    }

    return NextResponse.json({ ok: true, data: agent }, { status: 201 });
  } catch (error) {
    console.error('[personal agents POST]', error);
    return jsonError('서버 오류가 발생했습니다.', 500);
  }
}
