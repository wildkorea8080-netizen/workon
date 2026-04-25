import { NextRequest, NextResponse } from 'next/server';
import { supabaseAdmin } from '@/lib/supabaseAdmin';
import { getServerAuthSession } from '@/lib/auth';

export const dynamic = 'force-dynamic';

function nextAuthCookieName() {
  const url = process.env.NEXTAUTH_URL ?? '';
  return url.startsWith('https://')
    ? '__Secure-next-auth.session-token'
    : 'next-auth.session-token';
}

export async function POST(_request: NextRequest) {
  try {
    // 현재 impersonation 세션에서 log ID 추출
    const session = await getServerAuthSession();
    const logId = session?.user?.impersonateLogId;

    if (logId) {
      await supabaseAdmin
        .from('impersonation_logs')
        .update({ ended_at: new Date().toISOString() })
        .eq('id', logId);
    }

    // NextAuth 세션 쿠키 삭제
    const response = NextResponse.json({ ok: true });
    response.cookies.set({
      name: nextAuthCookieName(),
      value: '',
      httpOnly: true,
      secure: (process.env.NEXTAUTH_URL ?? '').startsWith('https://'),
      sameSite: 'lax',
      path: '/',
      maxAge: 0,
    });

    return response;
  } catch (err: any) {
    console.error('[impersonate/end]', err);
    return NextResponse.json({ ok: false, error: err.message }, { status: 500 });
  }
}
