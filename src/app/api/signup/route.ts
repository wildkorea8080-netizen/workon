import { NextResponse } from 'next/server';
import { supabase } from '@/lib/supabase';
import { supabaseAdmin } from '@/lib/supabaseAdmin';
import type { ApiResponse } from '@/lib/db';

const MIN_PASSWORD_LENGTH = 8;

/**
 * 초대 없이 가입할 때 소속 부서를 정한다.
 *
 * 예전에는 전체 시스템에서 가장 오래된 부서를 배정했다. 그 결과 아무나
 * 가입하면 첫 번째 기관의 부서에 들어가 그 기관의 문서·비서·대화에 접근할
 * 수 있었다. 멀티테넌트에서 있어선 안 되는 동작이다.
 *
 * 이제 이메일 도메인으로 기관을 찾고, 그 기관 안에서만 부서를 고른다.
 * 도메인이 등록된 기관이 없으면 소속을 알 수 없으므로 가입을 막는다.
 */
async function resolveDepartmentByEmailDomain(email: string) {
  const domain = email.split('@')[1]?.toLowerCase();
  if (!domain) return null;

  const { data: org } = await supabaseAdmin
    .from('organizations')
    .select('id')
    .eq('domain', domain)
    .maybeSingle();

  if (!org) return null;

  // 기관 내 최상위 부서를 우선, 없으면 가장 먼저 만들어진 부서
  const { data: departments } = await supabaseAdmin
    .from('departments')
    .select('id, parent_id')
    .eq('organization_id', org.id)
    .order('created_at', { ascending: true });

  if (!departments?.length) return null;

  const root = departments.find((d: { parent_id: string | null }) => !d.parent_id);
  return (root ?? departments[0]).id as string;
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

    // ── 1단계: 초대 토큰 검증 (있을 경우) ───────────────────
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
          { ok: false, error: { message: '만료된 초대 링크입니다. 슈퍼관리자에게 새 링크를 요청하세요.' } },
          { status: 400 }
        );
      }
      inviteDeptId = inv.department_id;
      inviteRole   = inv.role ?? 'USER';
      inviteId     = inv.id;
    }

    // ── 2단계: Supabase Auth 사용자 생성 ─────────────────────
    let authUserId: string;

    if (inviteToken) {
      // 초대 기반: admin.createUser() 사용 → 이메일 발송 없음, rate limit 없음
      const { data: authData, error: authErr } = await supabaseAdmin.auth.admin.createUser({
        email,
        password,
        email_confirm: true,      // 이메일 확인 자동 완료
        user_metadata: { full_name: fullName },
      });

      if (authErr) {
        if (authErr.message?.includes('already registered') || authErr.message?.includes('already been registered')) {
          return NextResponse.json<ApiResponse<null>>(
            { ok: false, error: { message: '이미 가입된 이메일입니다. 로그인 페이지를 이용하세요.' } },
            { status: 400 }
          );
        }
        return NextResponse.json<ApiResponse<null>>(
          { ok: false, error: { message: authErr.message || '회원가입 중 오류가 발생했습니다.' } },
          { status: 400 }
        );
      }
      authUserId = authData.user.id;
    } else {
      // 일반 가입: 기존 signUp() 방식
      const { data: signUpData, error: signUpError } = await supabase.auth.signUp({
        email,
        password,
        options: {
          data: { full_name: fullName },
          emailRedirectTo: `${process.env.NEXTAUTH_URL || 'http://localhost:3000'}/login`,
        },
      });

      if (signUpError && !signUpError.message?.includes('User already registered')) {
        return NextResponse.json<ApiResponse<null>>(
          { ok: false, error: { message: signUpError.message || '회원가입 중 오류가 발생했습니다.' } },
          { status: 400 }
        );
      }
      if (!signUpData?.user) {
        return NextResponse.json<ApiResponse<null>>(
          { ok: false, error: { message: '회원가입에 실패했습니다. 잠시 후 다시 시도해주세요.' } },
          { status: 400 }
        );
      }
      authUserId = signUpData.user.id;
    }

    // ── 3단계: users 테이블 레코드 생성 ──────────────────────
    {
      // 특정 이메일에 ADMIN을 자동 부여하던 하드코딩을 제거했다.
      // 그 주소로 가입하는 누구나 기관 관리자가 되는 권한 상승 경로였다.
      // 관리자 지정은 초대(invitations.role) 또는 슈퍼관리자를 통해서만 한다.
      let departmentId: string | null = inviteDeptId;
      const role = inviteToken ? inviteRole : 'USER';

      if (!departmentId) {
        departmentId = await resolveDepartmentByEmailDomain(email);
      }

      if (!departmentId) {
        // 소속을 특정할 수 없으면 계정을 만들지 않는다.
        // 임의의 부서에 넣으면 타 기관 자료에 접근하게 된다.
        await supabaseAdmin.auth.admin.deleteUser(authUserId).catch(() => {});
        return NextResponse.json<ApiResponse<null>>(
          {
            ok: false,
            error: {
              message:
                '소속 기관을 확인할 수 없습니다. 관리자에게 받은 초대 링크로 가입해주세요.',
            },
          },
          { status: 403 }
        );
      }

      await createUserRecord(authUserId, email, fullName, role, departmentId);

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
