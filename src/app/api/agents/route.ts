import { NextRequest, NextResponse } from 'next/server';
import { getServerAuthSession } from '@/lib/auth';
import { supabaseAdmin } from '@/lib/supabaseAdmin';
import { getVisibleDepartmentIds } from '@/lib/department-scope';
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

    // 자기 부서 + 상위 부서의 비서를 함께 본다.
    // 상위 부서에 등록한 공통 비서를 하위 부서가 쓸 수 있어야 전 부서 활용이 된다.
    const visibleDeptIds = await getVisibleDepartmentIds(departmentId);

    // 즐겨찾기 탭: favoriteIds 기반으로 in() 쿼리
    if (favoritesOnly) {
      if (favoriteIds.length === 0) {
        return NextResponse.json({ ok: true, data: [] });
      }
      const { data: agents, error } = await supabaseAdmin
        .from('agents')
        .select('*')
        .in('department_id', visibleDeptIds)
        .in('id', favoriteIds)
        .eq('is_active', true)
        .order('created_at', { ascending: false });

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
      .in('department_id', visibleDeptIds)
      .eq('is_active', true)
      .eq('is_personal', false);

    if (category && category !== '전체') {
      query = query.eq('category', category);
    }

    const { data: agents, error } = await query.order('created_at', { ascending: false });

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
    const { name, description, system_prompt, config, enabled_connectors } = body;

    if (!name || typeof name !== 'string' || name.trim().length === 0) {
      return NextResponse.json(
        { ok: false, error: { message: '에이전트 이름은 필수입니다.' } },
        { status: 400 }
      );
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