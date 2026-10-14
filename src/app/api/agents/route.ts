import { NextRequest, NextResponse } from 'next/server';
import { getServerAuthSession } from '@/lib/auth';
import { supabaseAdmin } from '@/lib/supabaseAdmin';
import { getAccessScope, visibilityFilter } from '@/lib/department-scope';
import { splitAgentBody } from '@/lib/agent-patch';
import { getActorScope } from '@/lib/actor-scope';
import { jsonError, knownIds, validateModelForOrganization } from '@/lib/agent-route-helpers';

export async function GET(request: NextRequest) {
  try {
    const session = await getServerAuthSession();
    if (!session?.user?.id) {
      return NextResponse.json(
        { ok: false, error: { message: '인증이 필요합니다.' } },
        { status: 401 }
      );
    }

    // departmentId가 세션에 없으면 DB에서 조회
    let departmentId = session.user.departmentId;
    let favoriteIds: string[] = [];

    if (!departmentId) {
      const { data: user, error: userError } = await supabaseAdmin
        .from('users')
        .select('department_id, favorite_agent_ids')
        .eq('id', session.user.id)
        .maybeSingle();

      if (userError || !user?.department_id) {
        return NextResponse.json(
          { ok: false, error: { message: '부서 정보를 찾을 수 없습니다.' } },
          { status: 403 }
        );
      }
      departmentId = user.department_id;
      favoriteIds = user.favorite_agent_ids ?? [];
    } else {
      const { data: user } = await supabaseAdmin
        .from('users')
        .select('favorite_agent_ids')
        .eq('id', session.user.id)
        .maybeSingle();
      favoriteIds = user?.favorite_agent_ids ?? [];
    }

    if (!departmentId) {
      return NextResponse.json(
        { ok: false, error: { message: '부서 정보를 찾을 수 없습니다.' } },
        { status: 403 }
      );
    }

    const { searchParams } = new URL(request.url);
    const category = searchParams.get('category');
    const personalOnly = searchParams.get('personal') === 'true';
    const favoritesOnly = searchParams.get('favorites') === 'true';
    // 관리 화면은 '노출 대기중' 비서도 봐야 한다. 직원 화면은 보면 안 된다.
    const manageMode = searchParams.get('manage') === 'true' && session.user.role === 'ADMIN';

    // 기관 전체 공개 비서 + 내 부서 계통에 걸린 부서 제한 비서.
    // 대부분의 규정·매뉴얼은 전 직원 공통이므로 기관 전체가 기본이고,
    // 인사·감사처럼 제한이 필요한 것만 부서로 좁힌다.
    const scope = await getAccessScope(departmentId);
    const visibleFilter = visibilityFilter(scope);

    // 즐겨찾기 탭: favoriteIds 기반으로 in() 쿼리
    if (favoritesOnly) {
      if (favoriteIds.length === 0) {
        return NextResponse.json({ ok: true, data: [] });
      }
      const { data: agents, error } = await supabaseAdmin
        .from('agents')
        .select('*')
        .or(visibleFilter)
        .in('id', favoriteIds)
        .is('deleted_at', null)
        .eq('is_active', true)
        .order('display_order', { ascending: true })
        .order('name', { ascending: true });

      if (error) {
        return NextResponse.json(
          { ok: false, error: { message: '즐겨찾기 비서 조회 중 오류가 발생했습니다.' } },
          { status: 500 }
        );
      }
      return NextResponse.json({ ok: true, data: agents, meta: { favoriteIds } });
    }

    // 내 비서 탭 — 나만의 비서. 부서를 옮겨도 내 것이므로 부서로 거르지 않는다.
    if (personalOnly) {
      const { data: agents, error } = await supabaseAdmin
        .from('agents')
        .select('*')
        .eq('tier', 'personal')
        .eq('owner_id', session.user.id)
        .is('deleted_at', null)
        .order('created_at', { ascending: false });

      if (error) {
        return NextResponse.json(
          { ok: false, error: { message: '나만의 비서 조회 중 오류가 발생했습니다.' } },
          { status: 500 }
        );
      }
      return NextResponse.json({ ok: true, data: agents, meta: { favoriteIds } });
    }

    // 관리 화면 — 관리 범위의 공식·부서 비서. 꺼 둔 것도 보인다(다시 켜려면 보여야 한다).
    if (manageMode) {
      const actor = await getActorScope(session);
      if (!actor?.organizationId) return jsonError('소속 기관을 찾을 수 없습니다.', 403);
      const managed = actor.managedDepartmentIds.join(',');

      let manageQuery = supabaseAdmin
        .from('agents')
        .select('*')
        .eq('organization_id', actor.organizationId)
        .neq('tier', 'personal')
        .is('deleted_at', null)
        // 기관 전체 공식 비서 + 관리 범위 부서에 걸린 비서(부서로 좁힌 공식 · 부서 비서)
        .or(`and(tier.eq.official,visibility.eq.organization),department_id.in.(${managed})`);

      if (category && category !== '전체') manageQuery = manageQuery.eq('category', category);

      const { data: agents, error } = await manageQuery
        .order('display_order', { ascending: true })
        .order('name', { ascending: true });
      if (error) return jsonError('에이전트 조회 중 오류가 발생했습니다.', 500);
      return NextResponse.json({ ok: true, data: agents, meta: { favoriteIds } });
    }

    // 카테고리 / 전체 비서 — 공식 비서 + 내 부서 계통의 부서 비서.
    // 부서 비서는 visibility='department'라 visibilityFilter가 내 부서 계통만 남긴다.
    const departmentOnly = searchParams.get('department') === 'true';
    let query = supabaseAdmin
      .from('agents')
      .select('*')
      .or(visibleFilter)
      .eq('is_active', true)
      .is('deleted_at', null);

    query = departmentOnly ? query.eq('tier', 'department') : query.neq('tier', 'personal');

    // 노출 대기중은 공식 비서에만 있다. 부서 비서는 승인 없이 바로 쓴다(결정 4).
    // (관리 화면은 위에서 따로 돌려줬다)
    query = query.or('tier.eq.department,is_published.eq.true');

    if (category && category !== '전체') {
      query = query.eq('category', category);
    }

    // 관리자가 정한 순서를 따르고, 동률이면 이름순으로 안정시킨다.
    // created_at 역순이면 비서를 하나 고칠 때마다 자리가 바뀌어 보인다.
    const { data: agents, error } = await query
      .order('display_order', { ascending: true })
      .order('name', { ascending: true });

    if (error) {
      return NextResponse.json(
        { ok: false, error: { message: '에이전트 조회 중 오류가 발생했습니다.' } },
        { status: 500 }
      );
    }

    return NextResponse.json({ ok: true, data: agents, meta: { favoriteIds } });
  } catch (error) {
    console.error('에이전트 목록 조회 오류:', error);
    return NextResponse.json(
      { ok: false, error: { message: '서버 오류가 발생했습니다.' } },
      { status: 500 }
    );
  }
}

export async function POST(request: NextRequest) {
  try {
    const session = await getServerAuthSession();
    if (!session?.user?.id) {
      return NextResponse.json(
        { ok: false, error: { message: '인증이 필요합니다.' } },
        { status: 401 }
      );
    }

    if (session.user.role !== 'ADMIN') {
      return NextResponse.json(
        { ok: false, error: { message: '관리자 권한이 필요합니다.' } },
        { status: 403 }
      );
    }

    const departmentId = session.user.departmentId;
    if (!departmentId) {
      return NextResponse.json(
        { ok: false, error: { message: '부서 정보를 찾을 수 없습니다.' } },
        { status: 403 }
      );
    }

    const body = (await request.json()) as Record<string, unknown>;

    const split = splitAgentBody(body, { currentType: 'chat', ...knownIds() });
    if (split.error) return jsonError(split.error, 400);
    if (!split.settings.name) return jsonError('에이전트 이름은 필수입니다.', 400);

    const actor = await getActorScope(session);
    if (!actor) return jsonError('소속 부서가 지정되지 않았습니다.', 403);

    // 기본은 기관 전체 공개. 규정·매뉴얼 대부분이 전 직원 공통이다.
    const visibility = split.operational.visibility === 'department' ? 'department' : 'organization';
    // 기관 전체 공개 공식 비서는 기관 전체를 관리하는 관리자만 만든다.
    // 부서 단위 관리자는 visibility를 'department'로 보내야 한다.
    if (visibility === 'organization' && !(actor.isAdmin && actor.managesWholeOrganization)) {
      return jsonError('기관 전체 공개는 기관 전체를 관리하는 관리자만 정할 수 있습니다.', 403);
    }

    const modelError = await validateModelForOrganization(split.settings.model_id, actor.organizationId);
    if (modelError) return jsonError(modelError, 400);

    const { data: agent, error } = await supabaseAdmin
      .from('agents')
      .insert({
        department_id: actor.departmentId,
        tier: 'official',
        ...split.settings,
        // 사진 읽기는 기본으로 켠다. 지금 모든 대화형 비서가 사진을 받는다.
        capabilities: split.settings.capabilities ?? { image: {} },
        created_by: session.user.id,
        updated_by: session.user.id,
        // 새 비서는 '노출 대기중'에서 시작한다(0019 기본값 false).
        ...split.operational,
        visibility,
      })
      .select()
      .single();

    if (error) {
      if (error.code === '23505') { // unique constraint
        return NextResponse.json(
          { ok: false, error: { message: '동일한 이름의 에이전트가 이미 존재합니다.' } },
          { status: 409 }
        );
      }
      return NextResponse.json(
        { ok: false, error: { message: '에이전트 생성 중 오류가 발생했습니다.' } },
        { status: 500 }
      );
    }

    // 사용 로그 기록
    await supabaseAdmin.from('usage_logs').insert({
      department_id: actor.departmentId,
      user_id: session!.user.id,
      action: 'create_agent',
      resource_type: 'agent',
      resource_id: agent.id,
      details: { name: agent.name },
    });

    return NextResponse.json({ ok: true, data: agent }, { status: 201 });
  } catch (error) {
    console.error('에이전트 생성 오류:', error);
    return NextResponse.json(
      { ok: false, error: { message: '서버 오류가 발생했습니다.' } },
      { status: 500 }
    );
  }
}