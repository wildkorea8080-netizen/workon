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

    const normalizedEmail = email.trim().toLowerCase();

    // 3) 이미 슈퍼관리자가 존재하는지 확인
    const { data: existing } = await supabaseAdmin
      .from('users')
      .select('id, email')
      .eq('is_super_admin', true)
      .maybeSingle();

    if (existing) {
      return NextResponse.json(
        { ok: false, error: '이미 슈퍼관리자 계정이 존재합니다. 추가 생성은 슈퍼관리자 포털에서 진행하세요.' },
        { status: 409 }
      );
    }

    // 4) Supabase Auth에 이미 존재하는 이메일인지 확인
    //    존재하면 새로 생성하지 않고 기존 계정을 슈퍼관리자로 승격
    let authUserId: string;

    const { data: authList } = await supabaseAdmin.auth.admin.listUsers({ perPage: 1000 });
    const existingAuthUser = authList?.users?.find(u => u.email === normalizedEmail);

    if (existingAuthUser) {
      // 기존 Auth 계정 재사용 — 비밀번호 변경도 적용
      authUserId = existingAuthUser.id;
      await supabaseAdmin.auth.admin.updateUserById(authUserId, { password });
    } else {
      // 신규 Auth 계정 생성
      const { data: newAuth, error: authError } = await supabaseAdmin.auth.admin.createUser({
        email: normalizedEmail,
        password,
        email_confirm: true,
        user_metadata: { full_name: name },
      });
      if (authError || !newAuth.user) {
        throw new Error(authError?.message ?? 'Auth 사용자 생성 실패');
      }
      authUserId = newAuth.user.id;
    }

    // 5) users 테이블에 슈퍼관리자로 등록 (upsert)
    const { error: upsertError } = await supabaseAdmin
      .from('users')
      .upsert({
        id: authUserId,
        email: normalizedEmail,
        full_name: name,
        role: 'ADMIN',
        is_super_admin: true,
      }, { onConflict: 'id' });

    if (upsertError) {
      throw new Error(upsertError.message);
    }

    return NextResponse.json({
      ok: true,
      message: '슈퍼관리자 계정이 설정됐습니다. 로그인 탭에서 접속하세요.',
    });
  } catch (err) {
    console.error('[super/auth/setup]', err);
    return NextResponse.json(
      { ok: false, error: err instanceof Error ? err.message : '서버 오류가 발생했습니다.' },
      { status: 500 }
    );
  }
}
