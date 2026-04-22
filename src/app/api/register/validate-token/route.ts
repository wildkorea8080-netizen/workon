import { NextRequest, NextResponse } from 'next/server';
import { supabaseAdmin } from '@/lib/supabaseAdmin';

export async function GET(request: NextRequest) {
  try {
    const token = request.nextUrl.searchParams.get('token');

    if (!token) {
      return NextResponse.json(
        { ok: false, error: { message: '토큰이 필요합니다.' } },
        { status: 400 }
      );
    }

    const { data: invitation, error } = await supabaseAdmin
      .from('invitations')
      .select('id, email, department_id, role, expires_at, accepted_at')
      .eq('token', token)
      .single();

    if (error || !invitation) {
      return NextResponse.json(
        { ok: false, error: { message: '유효하지 않은 초대 링크입니다.' } },
        { status: 404 }
      );
    }

    if (invitation.accepted_at) {
      return NextResponse.json(
        { ok: false, error: { message: '이미 사용된 초대 링크입니다.' } },
        { status: 400 }
      );
    }

    if (new Date(invitation.expires_at) < new Date()) {
      return NextResponse.json(
        { ok: false, error: { message: '만료된 초대 링크입니다.' } },
        { status: 400 }
      );
    }

    return NextResponse.json({
      ok: true,
      data: {
        valid: true,
        email: invitation.email,
        departmentId: invitation.department_id,
        role: invitation.role,
        expiresAt: invitation.expires_at,
      },
    });
  } catch (error) {
    console.error('[validate-token] 오류:', error);
    return NextResponse.json(
      { ok: false, error: { message: '서버 오류가 발생했습니다.' } },
      { status: 500 }
    );
  }
}
