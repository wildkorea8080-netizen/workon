import { NextRequest, NextResponse } from 'next/server';
import { getSuperAdminFromRequest } from '@/lib/super-auth';
import { supabaseAdmin } from '@/lib/supabaseAdmin';
import { accountLocks, lockReadDeps } from '@/lib/sign-in-throttle';
import { dbErrorText } from '@/lib/db-error-text';
import { writeAuditRow } from '@/lib/audit-write';
import { generateTempPassword } from '@/lib/password-reset';

export const dynamic = 'force-dynamic';


// GET: 슈퍼관리자 목록
export async function GET(request: NextRequest) {
  if (!getSuperAdminFromRequest(request))
    return NextResponse.json({ ok: false, error: '인증 필요' }, { status: 401 });

  const { data, error } = await supabaseAdmin
    .from('users')
    .select('id, email, full_name, created_at, updated_at, is_active')
    .eq('is_super_admin', true)
    .order('created_at', { ascending: true });

  if (error) return NextResponse.json({ ok: false, error: dbErrorText(error) }, { status: 500 });
  // 슈퍼관리자 로그인 실패로 잠긴 계정(0091) — 풀리는 때
  const locks = await accountLocks(lockReadDeps(), 'super', (data ?? []).map((u: { email: string }) => u.email)).catch(() => new Map<string, string>());
  return NextResponse.json({ ok: true, data: (data ?? []).map((u: { email: string }) => ({ ...u, sign_in_locked_until: locks.get(u.email) ?? null })) });
}

// POST: 슈퍼관리자 추가
export async function POST(request: NextRequest) {
  const admin = getSuperAdminFromRequest(request);
  if (!admin) return NextResponse.json({ ok: false, error: '인증 필요' }, { status: 401 });

  try {
    const { name, email } = await request.json();
    if (!name || !email) return NextResponse.json({ ok: false, error: '이름, 이메일 필수' }, { status: 400 });

    const normalizedEmail = email.trim().toLowerCase();

    // 이미 존재하는 이메일 확인
    const { data: existing } = await supabaseAdmin
      .from('users').select('id').eq('email', normalizedEmail).maybeSingle();
    if (existing) return NextResponse.json({ ok: false, error: '이미 등록된 이메일입니다.' }, { status: 409 });

    // 직원 재발급과 같은 임시 비밀번호(대·소문자·숫자, 나머지 편향 없음) — 첫 로그인에 바꾸게 한다(2026-11-17)
    const tempPassword = generateTempPassword();

    // Supabase Auth 사용자 생성
    const { data: authList } = await supabaseAdmin.auth.admin.listUsers({ perPage: 1000 });
    const existingAuth = authList?.users?.find(u => u.email === normalizedEmail);

    let authUserId: string;
    if (existingAuth) {
      authUserId = existingAuth.id;
      await supabaseAdmin.auth.admin.updateUserById(authUserId, { password: tempPassword, email_confirm: true });
    } else {
      const { data: newAuth, error: authErr } = await supabaseAdmin.auth.admin.createUser({
        email: normalizedEmail, password: tempPassword, email_confirm: true,
        user_metadata: { full_name: name },
      });
      if (authErr || !newAuth.user) throw authErr ?? new Error('Auth 생성 실패');
      authUserId = newAuth.user.id;
    }

    // users 테이블 등록
    const { data: newUser, error: insertErr } = await supabaseAdmin
      .from('users')
      .upsert({ id: authUserId, email: normalizedEmail, full_name: name, role: 'ADMIN', is_super_admin: true, password_must_change: true, password_changed_at: new Date().toISOString() }, { onConflict: 'id' })
      .select('id, email, full_name').single();

    if (insertErr) throw insertErr;

    // 조작 기록(2026-11-17) — 임시 비밀번호는 남기지 않는다
    await writeAuditRow('super_admin_logs', {
      admin_user_id: admin.sub,
      action: 'super_admin_created',
      target_type: 'user',
      target_id: newUser.id,
      after_data: { email: newUser.email },
    }, 'super_admin_created');

    return NextResponse.json({ ok: true, data: { ...newUser, tempPassword } });
  } catch (err: any) {
    console.error('[super-admins POST]', err);
    return NextResponse.json({ ok: false, error: dbErrorText(err) }, { status: 500 });
  }
}
