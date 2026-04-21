import { NextRequest, NextResponse } from 'next/server';
import bcrypt from 'bcryptjs';
import { getServerAuthSession, isAdminSession } from '@/lib/auth';
import { supabaseAdmin } from '@/lib/supabaseAdmin';

export async function GET(_request: NextRequest) {
  try {
    const session = await getServerAuthSession();
    if (!session?.user?.id || !isAdminSession(session)) {
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

    // 관리자는 같은 부서의 모든 사용자 조회 가능
    const { data: users, error } = await supabaseAdmin
      .from('users')
      .select('id, email, full_name, role, created_at')
      .eq('department_id', departmentId)
      .order('created_at', { ascending: false });

    if (error) {
      console.error('사용자 목록 조회 오류:', error);
      return NextResponse.json(
        { ok: false, error: { message: '사용자 목록을 불러올 수 없습니다.' } },
        { status: 500 }
      );
    }

    return NextResponse.json({ ok: true, data: users });
  } catch (error) {
    console.error('사용자 목록 조회 중 오류:', error);
    return NextResponse.json(
      { ok: false, error: { message: '오류가 발생했습니다.', details: error } },
      { status: 500 }
    );
  }
}

export async function POST(request: NextRequest) {
  try {
    const session = await getServerAuthSession();
    if (!session?.user?.id || !isAdminSession(session)) {
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
    const { email, full_name, role } = body;

    if (!email) {
      return NextResponse.json(
        { ok: false, error: { message: '이메일은 필수입니다.' } },
        { status: 400 }
      );
    }

    // 이메일 중복 확인
    const { data: existingUser } = await supabaseAdmin
      .from('users')
      .select('id')
      .eq('email', email)
      .single();

    if (existingUser) {
      return NextResponse.json(
        { ok: false, error: { message: '이미 존재하는 이메일입니다.' } },
        { status: 400 }
      );
    }

    // 임시 비밀번호 생성 후 bcrypt(saltRounds=12)로 해싱
    const tempPassword = Math.random().toString(36).slice(-12);
    const hashedPassword = await bcrypt.hash(tempPassword, 12);

    const { data: newUser, error } = await supabaseAdmin
      .from('users')
      .insert({
        email,
        full_name: full_name || null,
        role: role || 'USER',
        department_id: departmentId,
        password_hash: hashedPassword,
      })
      .select()
      .single();

    if (error) {
      console.error('사용자 생성 오류:', error);
      return NextResponse.json(
        { ok: false, error: { message: '사용자를 생성할 수 없습니다.' } },
        { status: 500 }
      );
    }

    // TODO: 초대 이메일 발송 (임시 비밀번호 포함)
    // tempPassword를 이메일로 전송해야 사용자가 최초 로그인 가능

    return NextResponse.json({
      ok: true,
      data: { id: newUser.id, email: newUser.email, role: newUser.role },
      tempPassword, // 이메일 미구현 동안 응답에 포함 — 프로덕션에서는 제거 후 이메일 발송으로 대체
      message: '사용자가 생성되었습니다.',
    });
  } catch (error) {
    console.error('사용자 생성 중 오류:', error);
    return NextResponse.json(
      { ok: false, error: { message: '오류가 발생했습니다.', details: error } },
      { status: 500 }
    );
  }
}

