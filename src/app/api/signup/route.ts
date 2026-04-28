import { NextResponse } from 'next/server';
import { supabase } from '@/lib/supabase';
import { supabaseAdmin } from '@/lib/supabaseAdmin';
import type { ApiResponse } from '@/lib/db';

const ADMIN_EMAILS = ['admin@welfare.org', 'admin@researchcenter.kr'];
const ADMIN_DEPARTMENT_SLUG = 'admin-team';
const MIN_PASSWORD_LENGTH = 8;

async function getDepartmentIdBySlug(slug: string) {
  const { data: department, error } = await supabaseAdmin
    .from('departments')
    .select('id')
    .eq('slug', slug)
    .maybeSingle();

  if (error) {
    console.warn('[signup] department lookup failed:', error.message);
    return null;
  }

  return department?.id ?? null;
}

async function getDefaultDepartmentId() {
  const { data: departments, error } = await supabaseAdmin
    .from('departments')
    .select('id')
    .order('created_at', { ascending: true })
    .limit(1);

  if (error || !departments?.length) {
    console.warn('[signup] default department lookup failed:', error?.message);
    return null;
  }

  return departments[0].id;
}

async function createUserRecord(userId: string, email: string, fullName: string, role: string, departmentId: string | null) {
  const insertData = {
    id: userId,
    email,
    full_name: fullName,
    role,
    department_id: departmentId,
  };

  const { error } = await supabaseAdmin.from('users').insert(insertData);
  if (error) {
    if (error.code === '23505') {
      return;
    }
    console.warn('[signup] users insert failed:', error.message);
  }
}

export async function POST(request: Request) {
  try {
    const body = await request.json();
    const email           = typeof body.email           === 'string' ? body.email.toLowerCase().trim() : '';
    const password        = typeof body.password        === 'string' ? body.password : '';
    const confirmPassword = typeof body.confirmPassword === 'string' ? body.confirmPassword : '';
    const fullName        = typeof body.fullName        === 'string' ? body.fullName.trim() : '';
    const inviteToken     = typeof body.inviteToken     === 'string' ? body.inviteToken.trim() : '';

    if (!email || !password || !confirmPassword || !fullName) {
      return NextResponse.json<ApiResponse<null>>(
        { ok: false, error: { message: '이메일, 이름, 비밀번호를 모두 입력해주세요.' } },
        { status: 400 }
      );
    }

    if (password !== confirmPassword) {
      return NextResponse.json<ApiResponse<null>>(
        { ok: false, error: { message: '비밀번호가 일치하지 않습니다.' } },
        { status: 400 }
      );
    }

    if (password.length < MIN_PASSWORD_LENGTH) {
      return NextResponse.json<ApiResponse<null>>(
        { ok: false, error: { message: `비밀번호는 최소 ${MIN_PASSWORD_LENGTH}자 이상이어야 합니다.` } },
        { status: 400 }
      );
    }

    // 이메일 확인 없이 즉시 회원가입 처리
    const { data: signUpData, error: signUpError } = await supabase.auth.signUp({
      email,
      password,
      options: {
        data: { full_name: fullName },
        emailRedirectTo: `${process.env.NEXTAUTH_URL || 'http://localhost:3000'}/login?role=user`
      }
    });

    if (signUpError) {
      // 이메일 확인 오류가 아닌 다른 오류만 처리
      if (!signUpError.message?.includes('User already registered')) {
        return NextResponse.json<ApiResponse<null>>(
          { ok: false, error: { message: signUpError.message || '회원가입 중 오류가 발생했습니다.' } },
          { status: 400 }
        );
      }
    }

    // ── 초대 토큰 검증 ────────────────────────────────────
    let inviteDeptId: string | null = null;
    let inviteRole = 'USER';
    let inviteId: string | null = null;

    if (inviteToken) {
      const { data: inv } = await supabaseAdmin
        .from('invitations')
        .select('id, email, role, department_id, expires_at, accepted_at')
        .eq('token', inviteToken)
        .maybeSingle();

      if (!inv) {
        return NextResponse.json<ApiResponse<null>>(
          { ok: false, error: { message: '유효하지 않은 초대 링크입니다.' } },
          { status: 400 }
        );
      }
      if (inv.accepted_at) {
        return NextResponse.json<ApiResponse<null>>(
          { ok: false, error: { message: '이미 사용된 초대 링크입니다.' } },
          { status: 400 }
        );
      }
      if (new Date(inv.expires_at) < new Date()) {
        return NextResponse.json<ApiResponse<null>>(
          { ok: false, error: { message: '만료된 초대 링크입니다.' } },
          { status: 400 }
        );
      }
      // 이메일이 지정된 초대인 경우 이메일 일치 확인
      if (inv.email && inv.email !== email) {
        return NextResponse.json<ApiResponse<null>>(
          { ok: false, error: { message: `이 초대 링크는 ${inv.email} 이메일 전용입니다.` } },
          { status: 400 }
        );
      }
      inviteDeptId = inv.department_id;
      inviteRole   = inv.role ?? 'USER';
      inviteId     = inv.id;
    }

    // 사용자 레코드 생성
    if (signUpData?.user) {
      const isAdminEmail = ADMIN_EMAILS.includes(email);
      // 초대 토큰이 있으면 초대의 부서/역할 사용, 없으면 기본값
      let departmentId: string | null = inviteDeptId;
      const role = inviteToken ? inviteRole : (isAdminEmail ? 'ADMIN' : 'USER');

      if (!departmentId) {
        departmentId = isAdminEmail
          ? await getDepartmentIdBySlug(ADMIN_DEPARTMENT_SLUG)
          : await getDefaultDepartmentId();
      }

      await createUserRecord(signUpData.user.id, email, fullName, role, departmentId);

      // 초대 수락 처리
      if (inviteId) {
        await supabaseAdmin
          .from('invitations')
          .update({ accepted_at: new Date().toISOString() })
          .eq('id', inviteId);
      }
    }

    return NextResponse.json<ApiResponse<{ message: string }>>(
      { ok: true, data: { message: '회원가입이 완료되었습니다. 이제 로그인할 수 있습니다.' } },
      { status: 201 }
    );
  } catch (error) {
    console.error('[signup] error:', error);
    return NextResponse.json<ApiResponse<null>>(
      { ok: false, error: { message: '서버 오류가 발생했습니다.' } },
      { status: 500 }
    );
  }
}
