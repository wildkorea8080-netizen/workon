import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { supabaseAdmin } from '@/lib/supabaseAdmin';
import { signSuperJWT, SUPER_COOKIE_NAME } from '@/lib/super-auth';
import { logAccess } from '@/lib/logger';

export const dynamic = 'force-dynamic';

export async function POST(request: NextRequest) {
  try {
    const { email, password } = await request.json();

    if (!email || !password) {
      return NextResponse.json(
        { ok: false, error: '이메일과 비밀번호를 입력하세요.' },
        { status: 400 }
      );
    }

    const normalizedEmail = email.trim().toLowerCase();

    // 1) anon key 클라이언트로 비밀번호 검증
    //    service role 키는 signInWithPassword 용도에 적합하지 않음
    const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL!;
    const supabaseAnonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!;
    const authClient = createClient(supabaseUrl, supabaseAnonKey, {
      auth: { persistSession: false },
    });

    const { data: authData, error: authError } = await authClient.auth.signInWithPassword({
      email: normalizedEmail,
      password,
    });

    if (authError || !authData.user) {
      logAccess({ action: 'login_failed', path: '/super/login',
        ipAddress: request.headers.get('x-forwarded-for'),
        userAgent: request.headers.get('user-agent'),
        statusCode: 401, details: { email: normalizedEmail } });
      return NextResponse.json(
        { ok: false, error: '이메일 또는 비밀번호가 올바르지 않습니다.' },
        { status: 401 }
      );
    }

    // 2) users 테이블에서 is_super_admin 확인 (service role로 조회)
    const { data: user, error: userError } = await supabaseAdmin
      .from('users')
      .select('id, email, full_name, is_super_admin')
      .eq('id', authData.user.id)
      .eq('is_super_admin', true)
      .maybeSingle();

    if (userError || !user) {
      return NextResponse.json(
        { ok: false, error: '슈퍼관리자 권한이 없습니다.' },
        { status: 403 }
      );
    }

    // 3) updated_at 갱신
    await supabaseAdmin
      .from('users')
      .update({ updated_at: new Date().toISOString() })
      .eq('id', user.id);

    // 4) 커스텀 JWT 발급
    const jwt = signSuperJWT(
      user.id,
      user.email,
      user.full_name ?? user.email
    );

    // 5) 로그인 성공 기록
    logAccess({ userId: user.id, action: 'login', path: '/super/login',
      ipAddress: request.headers.get('x-forwarded-for'),
      userAgent: request.headers.get('user-agent'),
      statusCode: 200 });

    // 6) httpOnly 쿠키 설정
    const response = NextResponse.json({ ok: true });
    response.cookies.set({
      name: SUPER_COOKIE_NAME,
      value: jwt,
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'lax',
      path: '/',
      maxAge: 86400,
    });

    return response;
  } catch (err) {
    console.error('[super/auth/login]', err);
    return NextResponse.json(
      { ok: false, error: '서버 오류가 발생했습니다.' },
      { status: 500 }
    );
  }
}
