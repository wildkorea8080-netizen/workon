import { NextRequest, NextResponse } from 'next/server';
import { getServerAuthSession } from '@/lib/auth';
import { supabaseAdmin } from '@/lib/supabaseAdmin';

export async function GET(_request: NextRequest) {
  try {
    const session = await getServerAuthSession();
    if (!session?.user?.id) {
      return NextResponse.json(
        { ok: false, error: { message: '인증이 필요합니다.' } },
        { status: 401 }
      );
    }

    const { data: user, error: userError } = await supabaseAdmin
      .from('users')
      .select('favorite_agent_ids, department_id')
      .eq('id', session.user.id)
      .single();

    if (userError || !user) {
      return NextResponse.json(
        { ok: false, error: { message: '사용자 정보를 찾을 수 없습니다.' } },
        { status: 404 }
      );
    }

    const favoriteIds: string[] = user.favorite_agent_ids ?? [];

    if (favoriteIds.length === 0) {
      return NextResponse.json({ ok: true, data: [] });
    }

    const { data: agents, error } = await supabaseAdmin
      .from('agents')
      .select('*')
      .eq('department_id', user.department_id)
      .in('id', favoriteIds)
      .eq('is_active', true);

    if (error) {
      return NextResponse.json(
        { ok: false, error: { message: '즐겨찾기 비서 조회 중 오류가 발생했습니다.' } },
        { status: 500 }
      );
    }

    return NextResponse.json({ ok: true, data: agents });
  } catch (error) {
    console.error('[favorite GET]', error);
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

    const body = await request.json();
    const { agentId } = body;

    if (!agentId || typeof agentId !== 'string') {
      return NextResponse.json(
        { ok: false, error: { message: 'agentId가 필요합니다.' } },
        { status: 400 }
      );
    }

    const { data: user, error: userError } = await supabaseAdmin
      .from('users')
      .select('favorite_agent_ids')
      .eq('id', session.user.id)
      .single();

    if (userError || !user) {
      return NextResponse.json(
        { ok: false, error: { message: '사용자 정보를 찾을 수 없습니다.' } },
        { status: 404 }
      );
    }

    const current: string[] = user.favorite_agent_ids ?? [];
    const isFavorite = current.includes(agentId);
    const updated = isFavorite
      ? current.filter((id: string) => id !== agentId)
      : [...current, agentId];

    const { error } = await supabaseAdmin
      .from('users')
      .update({ favorite_agent_ids: updated })
      .eq('id', session.user.id);

    if (error) {
      return NextResponse.json(
        { ok: false, error: { message: '즐겨찾기 업데이트 중 오류가 발생했습니다.' } },
        { status: 500 }
      );
    }

    return NextResponse.json({
      ok: true,
      data: { isFavorite: !isFavorite, favoriteIds: updated },
    });
  } catch (error) {
    console.error('[favorite POST]', error);
    return NextResponse.json(
      { ok: false, error: { message: '서버 오류가 발생했습니다.' } },
      { status: 500 }
    );
  }
}
