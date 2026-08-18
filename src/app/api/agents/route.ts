import { NextRequest, NextResponse } from 'next/server';
import { getServerAuthSession } from '@/lib/auth';
import { supabaseAdmin } from '@/lib/supabaseAdmin';
import { getAccessScope, visibilityFilter } from '@/lib/department-scope';
import { parseCatalogFields } from '@/lib/agent-catalog';
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

    // 내 비서 탭
    if (personalOnly) {
      const { data: agents, error } = await supabaseAdmin
        .from('agents')
        .select('*')
        .eq('department_id', departmentId)
        .eq('is_personal', true)
        .eq('owner_id', session.user.id)
        .order('created_at', { ascending: false });

      if (error) {
        return NextResponse.json(
          { ok: false, error: { message: '나만의 비서 조회 중 오류가 발생했습니다.' } },
          { status: 500 }
        );
      }
      return NextResponse.json({ ok: true, data: agents, meta: { favoriteIds } });
    }

    // 카테고리 / 전체 비서
    let query = supabaseAdmin
      .from('agents')
      .select('*')
      .or(visibleFilter)
      .eq('is_active', true)
      .eq('is_personal', false);

    // 노출 대기중(is_published=false)은 관리자가 공개 전에 직접 써 보는 상태다.
    if (!manageMode) {
      query = query.eq('is_published', true);
    }

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

    const body = await request.json();
    const { name, description, system_prompt, config, enabled_connectors, visibility } = body;

    if (!name || typeof name !== 'string' || name.trim().length === 0) {
      return NextResponse.json(
        { ok: false, error: { message: '에이전트 이름은 필수입니다.' } },
        { status: 400 }
      );
    }

    // 아이콘·카테고리·유형·정렬은 생성과 수정이 같은 규칙을 써야 한다.
    const { payload: catalog, error: catalogError } = parseCatalogFields(body);
    if (catalogError) {
      return NextResponse.json({ ok: false, error: { message: catalogError } }, { status: 400 });
    }

    // 에이전트 생성
    const { data: agent, error } = await supabaseAdmin
      .from('agents')
      .insert({
        department_id: departmentId,
        name: name.trim(),
        description: description?.trim(),
        system_prompt: system_prompt?.trim(),
        config: config || {},
        created_by: session!.user.id,
        updated_by: session!.user.id,
        enabled_connectors: Array.isArray(enabled_connectors) ? enabled_connectors : [],
        // 기본은 기관 전체 공개. 규정·매뉴얼 대부분이 전 직원 공통이라
        // 아무 설정 없이 만들어도 전 직원이 쓸 수 있어야 한다.
        visibility: visibility === 'department' ? 'department' : 'organization',
        // 새 비서는 '노출 대기중'에서 시작한다(0019가 기본값을 false로 둔다).
        // 관리자가 직접 써 보고 [메인 노출]을 눌러야 직원에게 보인다.
        ...catalog,
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
      department_id: departmentId,
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