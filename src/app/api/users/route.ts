import { NextRequest, NextResponse } from 'next/server';
import crypto from 'crypto';
import bcrypt from 'bcryptjs';
import { getServerAuthSession, isAdminSession } from '@/lib/auth';
import { supabaseAdmin } from '@/lib/supabaseAdmin';
import { getManagedDepartmentIds } from '@/lib/department-scope';

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

    // 관리자는 자기 부서와 그 하위 부서의 사용자를 관리한다.
    // 예전에는 자기 부서만 조회해, 하위 부서 직원을 볼 수도 옮길 수도 없었다.
    const managedDeptIds = await getManagedDepartmentIds(departmentId);

    const { data: users, error } = await supabaseAdmin
      .from('users')
      .select('id, email, full_name, role, created_at, department_id, monthly_budget_krw, departments(id, name)')
      .in('department_id', managedDeptIds)
      .order('created_at', { ascending: false });

    if (error) {
      console.error('사용자 목록 조회 오류:', error);
      return NextResponse.json(
        { ok: false, error: { message: '사용자 목록을 불러올 수 없습니다.' } },
        { status: 500 }
      );
    }

    // Supabase 조인은 객체 또는 배열로 오므로 정규화한다
    const normalized = (users ?? []).map((user: any) => {
      const dept = Array.isArray(user.departments) ? user.departments[0] : user.departments;
      return { ...user, departments: undefined, department_name: dept?.name ?? null };
    });

    return NextResponse.json({ ok: true, data: normalized });
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

    // 임시 비밀번호 생성 후 bcrypt(saltRounds=12)로 해싱.
    //
    // Math.random()을 쓰면 안 된다. 암호학적으로 안전하지 않아 예측이 가능하고,
    // 한 번 호출한 값을 toString(36)한 것이라 12자로 보여도 실제 엔트로피는
    // 그보다 훨씬 낮다. bulk-register·super-admins가 이미 쓰는 방식에 맞춘다.
    // 혼동하기 쉬운 글자(0/O, 1/l/I)는 뺀다 — 담당자가 구두로 전달하는 경우가 있다.
    const PASSWORD_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789';
    const tempPassword = Array.from(crypto.randomBytes(12))
      .map((b) => PASSWORD_CHARS[b % PASSWORD_CHARS.length])
      .join('');
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

