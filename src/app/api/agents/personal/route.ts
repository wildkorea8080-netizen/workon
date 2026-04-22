import { NextRequest, NextResponse } from 'next/server';
import { getServerAuthSession } from '@/lib/auth';
import { supabaseAdmin } from '@/lib/supabaseAdmin';

async function getDepartmentId(userId: string, session: { user: { departmentId?: string } }) {
  if (session.user.departmentId) return session.user.departmentId;
  const { data } = await supabaseAdmin
    .from('users')
    .select('department_id')
    .eq('id', userId)
    .maybeSingle();
  return data?.department_id ?? null;
}

export async function GET(_request: NextRequest) {
  try {
    const session = await getServerAuthSession();
    if (!session?.user?.id) {
      return NextResponse.json(
        { ok: false, error: { message: '인증이 필요합니다.' } },
        { status: 401 }
      );
    }

    const departmentId = await getDepartmentId(session.user.id, session as never);
    if (!departmentId) {
      return NextResponse.json(
        { ok: false, error: { message: '부서 정보를 찾을 수 없습니다.' } },
        { status: 403 }
      );
    }

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

    return NextResponse.json({ ok: true, data: agents });
  } catch (error) {
    console.error('[personal agents GET]', error);
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

    const departmentId = await getDepartmentId(session.user.id, session as never);
    if (!departmentId) {
      return NextResponse.json(
        { ok: false, error: { message: '부서 정보를 찾을 수 없습니다.' } },
        { status: 403 }
      );
    }

    const body = await request.json();
    const { name, description, systemPrompt, icon, color, category } = body;

    if (!name || typeof name !== 'string' || !name.trim()) {
      return NextResponse.json(
        { ok: false, error: { message: '비서 이름은 필수입니다.' } },
        { status: 400 }
      );
    }

    const { data: agent, error } = await supabaseAdmin
      .from('agents')
      .insert({
        department_id: departmentId,
        name: name.trim(),
        description: description?.trim() ?? null,
        system_prompt: systemPrompt?.trim() ?? null,
        icon: icon ?? null,
        color: color ?? null,
        category: category ?? '전체',
        is_personal: true,
        owner_id: session.user.id,
        created_by: session.user.id,
        updated_by: session.user.id,
      })
      .select()
      .single();

    if (error) {
      return NextResponse.json(
        { ok: false, error: { message: '나만의 비서 생성 중 오류가 발생했습니다.' } },
        { status: 500 }
      );
    }

    return NextResponse.json({ ok: true, data: agent }, { status: 201 });
  } catch (error) {
    console.error('[personal agents POST]', error);
    return NextResponse.json(
      { ok: false, error: { message: '서버 오류가 발생했습니다.' } },
      { status: 500 }
    );
  }
}
