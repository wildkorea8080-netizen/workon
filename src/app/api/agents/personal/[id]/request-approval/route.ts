import { NextRequest, NextResponse } from 'next/server';
import { getServerAuthSession } from '@/lib/auth';
import { supabaseAdmin } from '@/lib/supabaseAdmin';

export async function POST(request: NextRequest, { params }: { params: { id: string } }) {
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
      .select('id, owner_id, approval_status')
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
        { ok: false, error: { message: '본인의 비서만 신청할 수 있습니다.' } },
        { status: 403 }
      );
    }

    if (existing.approval_status === 'pending') {
      return NextResponse.json(
        { ok: false, error: { message: '이미 승인 신청 중입니다.' } },
        { status: 409 }
      );
    }

    if (existing.approval_status === 'approved') {
      return NextResponse.json(
        { ok: false, error: { message: '이미 공식 비서로 등록된 비서입니다.' } },
        { status: 409 }
      );
    }

    const body = await request.json().catch(() => ({}));
    const note: string | null = body.note?.trim() || null;

    const { error } = await supabaseAdmin
      .from('agents')
      .update({ approval_status: 'pending', approval_note: note })
      .eq('id', params.id);

    if (error) {
      return NextResponse.json(
        { ok: false, error: { message: '승인 신청 중 오류가 발생했습니다.' } },
        { status: 500 }
      );
    }

    return NextResponse.json({
      ok: true,
      data: { success: true, message: '관리자에게 신청됐습니다.' },
    });
  } catch (error) {
    console.error('[request-approval POST]', error);
    return NextResponse.json(
      { ok: false, error: { message: '서버 오류가 발생했습니다.' } },
      { status: 500 }
    );
  }
}
