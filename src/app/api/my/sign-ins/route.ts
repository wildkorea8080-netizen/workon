import { NextResponse } from 'next/server';
import { getServerAuthSession } from '@/lib/auth';
import { supabaseAdmin } from '@/lib/supabaseAdmin';
import { MY_SIGN_INS_DAYS, MY_SIGN_INS_LIMIT, deviceLabel, type MySignIn } from '@/lib/my-sign-ins-spec';

export const dynamic = 'force-dynamic';

/**
 * 내 로그인 기록(2026-11-16, 0094 접속 기록) — 본인 것만(세션의 사용자 id), 최근 90일·30건.
 * 대리 접근 중에는 보이지 않는다(그 관리자의 기록을 슈퍼관리자가 들여다보는 길이 되지 않게).
 * 브라우저 정보는 짧은 꼴(기기·브라우저)로만 내보낸다.
 */
export async function GET() {
  const session = await getServerAuthSession();
  if (!session?.user?.id) {
    return NextResponse.json({ ok: false, error: { message: '로그인이 필요합니다.' } }, { status: 401 });
  }
  if (session.user.isImpersonating) {
    return NextResponse.json({ ok: false, error: { message: '대리 접근 중에는 볼 수 없습니다.' } }, { status: 403 });
  }
  const since = new Date(Date.now() - MY_SIGN_INS_DAYS * 86_400_000).toISOString();
  const { data, error } = await supabaseAdmin
    .from('access_logs')
    .select('action, ip_address, user_agent, created_at')
    .eq('user_id', session.user.id)
    .eq('path', '/login')
    .gte('created_at', since)
    .order('created_at', { ascending: false })
    .limit(MY_SIGN_INS_LIMIT);
  if (error) {
    return NextResponse.json({ ok: false, error: { message: '로그인 기록을 불러오지 못했습니다.' } }, { status: 500 });
  }
  const list: MySignIn[] = (data ?? []).map((r: { action: string; ip_address: string | null; user_agent: string | null; created_at: string }) => ({
    at: r.created_at,
    action: r.action,
    ip: r.ip_address,
    device: deviceLabel(r.user_agent),
  }));
  return NextResponse.json({ ok: true, data: list });
}
