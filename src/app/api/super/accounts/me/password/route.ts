import { NextRequest, NextResponse } from 'next/server';
import { getSuperAdminFromRequest } from '@/lib/super-auth';
import { supabaseAdmin } from '@/lib/supabaseAdmin';
import { createClient } from '@supabase/supabase-js';

export const dynamic = 'force-dynamic';

export async function PATCH(request: NextRequest) {
  const admin = getSuperAdminFromRequest(request);
  if (!admin) return NextResponse.json({ ok: false, error: '인증 필요' }, { status: 401 });

  try {
    const { currentPassword, newPassword } = await request.json();
    if (!currentPassword || !newPassword)
      return NextResponse.json({ ok: false, error: '현재/새 비밀번호 필수' }, { status: 400 });
    if (newPassword.length < 8)
      return NextResponse.json({ ok: false, error: '새 비밀번호는 8자 이상' }, { status: 400 });

    // 현재 비밀번호 검증 (anon key 클라이언트로)
    const authClient = createClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
      { auth: { persistSession: false } }
    );
    const { error: signInErr } = await authClient.auth.signInWithPassword({
      email: admin.email,
      password: currentPassword,
    });
    if (signInErr)
      return NextResponse.json({ ok: false, error: '현재 비밀번호가 올바르지 않습니다.' }, { status: 400 });

    // 새 비밀번호로 변경
    const { error: updateErr } = await supabaseAdmin.auth.admin.updateUserById(
      admin.sub, { password: newPassword }
    );
    if (updateErr) throw new Error(updateErr.message);

    return NextResponse.json({ ok: true });
  } catch (err: any) {
    console.error('[me/password PATCH]', err);
    return NextResponse.json({ ok: false, error: err.message }, { status: 500 });
  }
}
