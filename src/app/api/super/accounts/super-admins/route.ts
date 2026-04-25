import { NextRequest, NextResponse } from 'next/server';
import { getSuperAdminFromRequest } from '@/lib/super-auth';
import { supabaseAdmin } from '@/lib/supabaseAdmin';
import crypto from 'crypto';

export const dynamic = 'force-dynamic';

function genTempPassword(): string {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789@#$!';
  return Array.from(crypto.randomBytes(12))
    .map(b => chars[b % chars.length]).join('');
}

// GET: 슈퍼관리자 목록
export async function GET(request: NextRequest) {
  if (!getSuperAdminFromRequest(request))
    return NextResponse.json({ ok: false, error: '인증 필요' }, { status: 401 });

  const { data, error } = await supabaseAdmin
    .from('users')
    .select('id, email, full_name, created_at, updated_at, is_active')
    .eq('is_super_admin', true)
    .order('created_at', { ascending: true });

  if (error) return NextResponse.json({ ok: false, error: error.message }, { status: 500 });
  return NextResponse.json({ ok: true, data: data ?? [] });
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

    const tempPassword = genTempPassword();

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
      if (authErr || !newAuth.user) throw new Error(authErr?.message ?? 'Auth 생성 실패');
      authUserId = newAuth.user.id;
    }

    // users 테이블 등록
    const { data: newUser, error: insertErr } = await supabaseAdmin
      .from('users')
      .upsert({ id: authUserId, email: normalizedEmail, full_name: name, role: 'ADMIN', is_super_admin: true }, { onConflict: 'id' })
      .select('id, email, full_name').single();

    if (insertErr) throw new Error(insertErr.message);

    return NextResponse.json({ ok: true, data: { ...newUser, tempPassword } });
  } catch (err: any) {
    console.error('[super-admins POST]', err);
    return NextResponse.json({ ok: false, error: err.message }, { status: 500 });
  }
}
