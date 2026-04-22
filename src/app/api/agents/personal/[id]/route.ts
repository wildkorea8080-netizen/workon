import { NextRequest, NextResponse } from 'next/server';
import { getServerAuthSession } from '@/lib/auth';
import { supabaseAdmin } from '@/lib/supabaseAdmin';

export async function PUT(request: NextRequest, { params }: { params: { id: string } }) {
  try {
    const session = await getServerAuthSession();
    if (!session?.user?.id) {
      return NextResponse.json(
        { ok: false, error: { message: '인증이 필요합니다.' } },
        { status: 401 }
      );
    }

    const { data: existing, error: fetchError } = await supabaseAdmin
      .from('agents')
      .select('id, owner_id')
      .eq('id', params.id)
      .eq('is_personal', true)
      .maybeSingle();

    if (fetchError || !existing) {
      return NextResponse.json(
        { ok: false, error: { message: '비서를 찾을 수 없습니다.' } },
        { status: 404 }
      );
    }

    if (existing.owner_id !== session.user.id) {
      return NextResponse.json(
        { ok: false, error: { message: '본인의 비서만 수정할 수 있습니다.' } },
        { status: 403 }
      );
    }

    const body = await request.json();
    const { name, description, systemPrompt, icon, color } = body;

    const updatePayload: Record<string, unknown> = { updated_by: session.user.id };
    if (name !== undefined) updatePayload.name = typeof name === 'string' ? name.trim() : name;
    if (description !== undefined) updatePayload.description = description;
    if (systemPrompt !== undefined) updatePayload.system_prompt = systemPrompt;
    if (icon !== undefined) updatePayload.icon = icon;
    if (color !== undefined) updatePayload.color = color;

    const { data: agent, error } = await supabaseAdmin
      .from('agents')
      .update(updatePayload)
      .eq('id', params.id)
      .select()
      .single();

    if (error) {
      return NextResponse.json(
        { ok: false, error: { message: '비서 수정 중 오류가 발생했습니다.' } },
        { status: 500 }
      );
    }

    return NextResponse.json({ ok: true, data: agent });
  } catch (error) {
    console.error('[personal agent PUT]', error);
    return NextResponse.json(
      { ok: false, error: { message: '서버 오류가 발생했습니다.' } },
      { status: 500 }
    );
  }
}

export async function DELETE(_request: NextRequest, { params }: { params: { id: string } }) {
  try {
    const session = await getServerAuthSession();
    if (!session?.user?.id) {
      return NextResponse.json(
        { ok: false, error: { message: '인증이 필요합니다.' } },
        { status: 401 }
      );
    }

    const { data: existing, error: fetchError } = await supabaseAdmin
      .from('agents')
      .select('id, owner_id')
      .eq('id', params.id)
      .eq('is_personal', true)
      .maybeSingle();

    if (fetchError || !existing) {
      return NextResponse.json(
        { ok: false, error: { message: '비서를 찾을 수 없습니다.' } },
        { status: 404 }
      );
    }

    if (existing.owner_id !== session.user.id) {
      return NextResponse.json(
        { ok: false, error: { message: '본인의 비서만 삭제할 수 있습니다.' } },
        { status: 403 }
      );
    }

    // 연결된 documents 삭제 후 agent 삭제 (FK cascade 없는 경우 대비)
    await supabaseAdmin.from('documents').delete().eq('agent_id', params.id);

    const { error } = await supabaseAdmin.from('agents').delete().eq('id', params.id);

    if (error) {
      return NextResponse.json(
        { ok: false, error: { message: '비서 삭제 중 오류가 발생했습니다.' } },
        { status: 500 }
      );
    }

    return NextResponse.json({ ok: true });
  } catch (error) {
    console.error('[personal agent DELETE]', error);
    return NextResponse.json(
      { ok: false, error: { message: '서버 오류가 발생했습니다.' } },
      { status: 500 }
    );
  }
}
