import { NextRequest, NextResponse } from 'next/server';
import bcrypt from 'bcryptjs';
import { supabaseAdmin } from '@/lib/supabaseAdmin';

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const { token, name, password } = body;

    if (!token || !password) {
      return NextResponse.json(
        { ok: false, error: { message: '토큰과 비밀번호는 필수입니다.' } },
        { status: 400 }
      );
    }

    if (password.length < 8) {
      return NextResponse.json(
        { ok: false, error: { message: '비밀번호는 8자 이상이어야 합니다.' } },
        { status: 400 }
      );
    }

    // 토큰 재검증
    const { data: invitation, error: inviteError } = await supabaseAdmin
      .from('invitations')
      .select('id, email, department_id, role, expires_at, accepted_at')
      .eq('token', token)
      .single();

    if (inviteError || !invitation) {
      return NextResponse.json(
        { ok: false, error: { message: '유효하지 않은 초대 링크입니다.' } },
        { status: 400 }
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

    // 이메일 중복 최종 확인
    const { data: existingUser } = await supabaseAdmin
      .from('users')
      .select('id')
      .eq('email', invitation.email)
      .single();

    if (existingUser) {
      return NextResponse.json(
        { ok: false, error: { message: '이미 가입된 이메일입니다.' } },
        { status: 400 }
      );
    }

    // 비밀번호 해싱
    const passwordHash = await bcrypt.hash(password, 12);

    // 사용자 생성
    const { data: newUser, error: userError } = await supabaseAdmin
      .from('users')
      .insert({
        email: invitation.email,
        full_name: name?.trim() || null,
        role: invitation.role,
        department_id: invitation.department_id,
        password_hash: passwordHash,
      })
      .select('id, email, role')
      .single();

    if (userError) {
      console.error('[register] 사용자 생성 오류:', userError);
      return NextResponse.json(
        { ok: false, error: { message: '회원가입에 실패했습니다.' } },
        { status: 500 }
      );
    }

    // 초대 수락 처리
    await supabaseAdmin
      .from('invitations')
      .update({ accepted_at: new Date().toISOString() })
      .eq('id', invitation.id);

    return NextResponse.json({
      ok: true,
      data: { id: newUser.id, email: newUser.email, role: newUser.role },
    });
  } catch (error) {
    console.error('[register] 오류:', error);
    return NextResponse.json(
      { ok: false, error: { message: '서버 오류가 발생했습니다.' } },
      { status: 500 }
    );
  }
}
