import { NextResponse } from 'next/server';
import { getServerAuthSession } from '@/lib/auth';
import { appBaseUrl, defaultSsoLogoutIo, ssoLogoutUrl } from '@/lib/org-sso';

export const dynamic = 'force-dynamic';

/**
 * 기관 SSO 함께 로그아웃(0111) — 로그아웃하기 **전에** 화면이 부른다. 기관 계정(SSO)으로 들어온 로그인이고 기관이 '함께 로그아웃'을
 * 켰으면 계정 서비스의 로그아웃 주소를, 아니면 null을 돌려준다. 이 라우트는 로그아웃을 하지 않는다 — 화면이 NextAuth 로그아웃을 마친 뒤
 * 그 주소로 간다(못 읽으면 null — WORKON 로그아웃만). 대리 접근 세션은 계정 서비스와 상관없어 null
 */
export async function POST() {
  const session = await getServerAuthSession();
  if (!session?.user?.id) return NextResponse.json({ ok: false, error: { message: '로그인이 필요합니다.' } }, { status: 401 });
  const departmentId = session.user.departmentId;
  if (session.user.sso !== true || session.user.isImpersonating || !departmentId) {
    return NextResponse.json({ ok: true, data: { redirect: null } });
  }
  const redirect = await ssoLogoutUrl(departmentId, defaultSsoLogoutIo(), appBaseUrl());
  return NextResponse.json({ ok: true, data: { redirect } }, { headers: { 'Cache-Control': 'no-store' } });
}
