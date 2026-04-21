import { NextRequest, NextResponse } from 'next/server';
import { getServerAuthSession } from '@/lib/auth';
import { supabaseAdmin } from '@/lib/supabaseAdmin';

// 편집된 보고서 내용 저장
export async function PATCH(
  request: NextRequest,
  { params }: { params: { id: string } }
) {
  try {
    const session = await getServerAuthSession();
    if (!session?.user?.id) {
      return NextResponse.json(
        { ok: false, error: { message: '인증이 필요합니다.' } },
        { status: 401 }
      );
    }

    const { report_content } = await request.json();
    if (typeof report_content !== 'string') {
      return NextResponse.json(
        { ok: false, error: { message: 'report_content가 필요합니다.' } },
        { status: 400 }
      );
    }

    // 본인 소유 로그만 수정 가능
    const { data: existing } = await supabaseAdmin
      .from('usage_logs')
      .select('id, details')
      .eq('id', params.id)
      .eq('user_id', session.user.id)
      .eq('action', 'generate_report')
      .single();

    if (!existing) {
      return NextResponse.json(
        { ok: false, error: { message: '보고서를 찾을 수 없습니다.' } },
        { status: 404 }
      );
    }

    const updatedDetails = {
      ...(existing.details as object),
      report_content,
      edited_at: new Date().toISOString(),
    };

    const { error } = await supabaseAdmin
      .from('usage_logs')
      .update({ details: updatedDetails })
      .eq('id', params.id);

    if (error) {
      return NextResponse.json(
        { ok: false, error: { message: '저장 실패' } },
        { status: 500 }
      );
    }

    return NextResponse.json({ ok: true, data: { saved: true } });
  } catch {
    return NextResponse.json(
      { ok: false, error: { message: '서버 오류가 발생했습니다.' } },
      { status: 500 }
    );
  }
}
