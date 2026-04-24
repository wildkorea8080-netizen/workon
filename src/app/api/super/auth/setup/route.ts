import { NextRequest, NextResponse } from 'next/server';
import { supabaseAdmin } from '@/lib/supabaseAdmin';

export const dynamic = 'force-dynamic';

export async function POST(request: NextRequest) {
  try {
    const { email, password, name, setupKey } = await request.json();

    // 1) 셋업 키 검증
    const validSetupKey = process.env.SUPER_ADMIN_SETUP_KEY;
    if (!validSetupKey || setupKey !== validSetupKey) {
      return NextResponse.json(
        { ok: false, error: '셋업 키가 올바르지 않습니다.' },
        { status: 403 }
      );
    }

    // 2) 필수값 확인
    if (!email || !password || !name) {
      return NextResponse.json(
        { ok: false, error: '이메일, 비밀번호, 이름은 필수입니다.' },
        { status: 400 }
      );
    }

    if (password.length < 8) {
      return NextResponse.json(
        { ok: false, error: '비밀번호는 8자 이상이어야 합니다.' },
        { status: 400 }
      );
    }

    // 3) 이미 슈퍼관리자가 존재하는지 확인
    const { data: existing } = await supabaseAdmin
      .from('users')
      .select('id')
      .eq('is_super_admin', true)
      .maybeSingle();

    if (existing) {
      return NextResponse.json(
        { ok: false, error: '이미 슈퍼관리자 계정이 존재합니다. 추가 생성은 슈퍼관리자 포털에서 진행하세요.' },
        { status: 409 }
      );
    }

    // 4) Supabase Auth에 사용자 생성
    const { data: authUser, error: authError } = await supabaseAdmin.auth.admin.createUser({
      email: email.trim().toLowerCase(),
      password,
      email_confirm: true,
      user_metadata: { full_name: name },
    });

    if (authError || !authUser.user) {
      throw new Error(authError?.message ?? 'Auth 사용자 생성 실패');
    }

    // 5) users 테이블에 슈퍼관리자로 등록
    const { error: insertError } = await supabaseAdmin
      .from('users')
      .upsert({
        id: authUser.user.id,
        email: email.trim().toLowerCase(),
        full_name: name,
        role: 'ADMIN',
        is_super_admin: true,
      }, { onConflict: 'id' });

    if (insertError) {
      // Auth 롤백
      await supabaseAdmin.auth.admin.deleteUser(authUser.user.id);
      throw new Error(insertError.message);
    }

    return NextResponse.json({
      ok: true,
      message: '슈퍼관리자 계정이 생성됐습니다. /super/login에서 로그인하세요.',
    });
  } catch (err) {
    console.error('[super/auth/setup]', err);
    return NextResponse.json(
      { ok: false, error: err instanceof Error ? err.message : '서버 오류가 발생했습니다.' },
      { status: 500 }
    );
  }
}
