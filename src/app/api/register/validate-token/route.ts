import { NextRequest, NextResponse } from 'next/server';
import { supabaseAdmin } from '@/lib/supabaseAdmin';
import { SIGNUP_READ_FAILED_MESSAGE } from '@/lib/signup-org';

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
      .maybeSingle();

    // 못 읽으면 '유효하지 않은 초대 링크'가 아니라 그렇다고(2026-11-20) — 가입(`/api/register`)은 2026-11-19에 같은 규칙으로 고쳤는데
    // 링크를 처음 열 때 확인하는 이 길은 `.single()`이라 읽기 실패도 '유효하지 않음'(404)이었다. 가입 화면은 이 답을 그대로 보이고 입력 칸을 닫는다
    if (error) {
      return NextResponse.json({ ok: false, error: { message: SIGNUP_READ_FAILED_MESSAGE } }, { status: 503 });
    }
    if (!invitation) {
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
