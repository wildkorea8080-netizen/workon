import { NextRequest, NextResponse } from 'next/server';
import { getSuperAdminFromRequest } from '@/lib/super-auth';
import { supabaseAdmin } from '@/lib/supabaseAdmin';
import { accountLocks, lockReadDeps } from '@/lib/sign-in-throttle';
import { dbErrorText } from '@/lib/db-error-text';
import { writeAuditRow } from '@/lib/audit-write';
import { generateTempPassword } from '@/lib/password-reset';
import { findAuthUserByEmail, parseSuperAdminInput } from '@/lib/super-admin-create';

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
//
// 2026-11-19 — 이미 있는 계정을 덮어쓰지 않는다. 예전에는
// ① 등록 여부를 못 읽으면 '없음'으로 보고 ② 같은 이메일의 Auth 계정을 찾아 **비밀번호를 바꾼 뒤**
// ③ users를 upsert(id 기준)해, 그 이메일이 직원 계정이면 직원 행이 슈퍼관리자로 덮였다(이름·권한도).
// Auth 비밀번호 바꾸기·찾기의 실패도 보지 않았고, 만든 Auth 계정은 users 쓰기가 실패해도 남았다.
export async function POST(request: NextRequest) {
  const admin = getSuperAdminFromRequest(request);
  if (!admin) return NextResponse.json({ ok: false, error: '인증 필요' }, { status: 401 });

  const input = parseSuperAdminInput(await request.json().catch(() => null));
  if (!input.ok) return NextResponse.json({ ok: false, error: input.message }, { status: 400 });
  const { name, email } = input;

  try {
    // 이미 있는 이메일 — 못 읽으면 만들지 않는다
    const { data: existingRows, error: existingError } = await supabaseAdmin
      .from('users').select('id').eq('email', email).limit(1);
    if (existingError) return NextResponse.json({ ok: false, error: '등록 여부를 확인하지 못했습니다. 잠시 뒤 다시 시도해 주세요.' }, { status: 503 });
    if ((existingRows ?? []).length > 0) return NextResponse.json({ ok: false, error: '이미 등록된 이메일입니다.' }, { status: 409 });

    // 직원 재발급과 같은 임시 비밀번호(대·소문자·숫자, 나머지 편향 없음) — 첫 로그인에 바꾸게 한다(2026-11-17)
    const tempPassword = generateTempPassword();

    // users 행 없이 남은 Auth 계정(예: 공개 가입으로 만든 계정)이면 그 계정을 쓰고 비밀번호를 바꾼다 — 쪽마다 끝까지 찾는다
    const found = await findAuthUserByEmail(email);
    if (found === undefined) return NextResponse.json({ ok: false, error: '로그인 계정을 확인하지 못했습니다. 잠시 뒤 다시 시도해 주세요.' }, { status: 503 });

    let authUserId: string;
    let createdAuth = false;
    if (found) {
      authUserId = found;
      const { error: pwError } = await supabaseAdmin.auth.admin.updateUserById(authUserId, { password: tempPassword, email_confirm: true });
      if (pwError) return NextResponse.json({ ok: false, error: '로그인 계정의 비밀번호를 정하지 못했습니다. 잠시 뒤 다시 시도해 주세요.' }, { status: 503 });
    } else {
      const { data: newAuth, error: authErr } = await supabaseAdmin.auth.admin.createUser({
        email, password: tempPassword, email_confirm: true,
        user_metadata: { full_name: name },
      });
      if (authErr || !newAuth.user) return NextResponse.json({ ok: false, error: '로그인 계정을 만들지 못했습니다. 잠시 뒤 다시 시도해 주세요.' }, { status: 500 });
      authUserId = newAuth.user.id;
      createdAuth = true;
    }

    // users 행은 **새로만** 넣는다(upsert면 같은 id의 행을 덮는다) — 그 사이 생긴 행과 겹치면 409
    const { data: newUser, error: insertErr } = await supabaseAdmin
      .from('users')
      .insert({ id: authUserId, email, full_name: name, role: 'ADMIN', is_super_admin: true, password_must_change: true, password_changed_at: new Date().toISOString() })
      .select('id, email, full_name').single();

    if (insertErr || !newUser) {
      // 이번에 만든 Auth 계정은 지운다(남으면 users 행 없는 로그인 계정이 된다)
      if (createdAuth) {
        const { error: delError } = await supabaseAdmin.auth.admin.deleteUser(authUserId);
        if (delError) console.error('[super-admins POST] 만든 Auth 계정을 지우지 못함', delError.message);
      }
      if (insertErr?.code === '23505') return NextResponse.json({ ok: false, error: '이미 등록된 이메일입니다.' }, { status: 409 });
      console.error('[super-admins POST]', insertErr);
      return NextResponse.json({ ok: false, error: dbErrorText(insertErr) }, { status: 500 });
    }

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
