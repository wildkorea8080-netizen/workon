import { NextRequest, NextResponse } from 'next/server';
import { NEXTAUTH_SECRET } from '@/lib/config';
import { appBaseUrl, defaultSsoIo, SSO_STATE_COOKIE, SSO_STATE_TTL_MS, startSso } from '@/lib/org-sso';

export const dynamic = 'force-dynamic';

/**
 * 기관 SSO 시작(0107) — 로그인 전이라 공개. 기관 전용 로그인(/signin/{slug})의 '기관 계정으로 로그인'이 여기로 온다.
 * 켜진 기관이면 계정 서비스의 인가 주소로 보내고(state·nonce·PKCE는 서명한 10분 쿠키에), 아니면 로그인 화면으로 까닭과 함께
 */
export async function GET(request: NextRequest, { params }: { params: { slug: string } }) {
  const base = appBaseUrl() || request.nextUrl.origin;
  const out = await startSso(params.slug, defaultSsoIo(), base, NEXTAUTH_SECRET);
  const res = NextResponse.redirect(new URL(out.redirect, base), 302);
  res.headers.set('Cache-Control', 'no-store');
  if (out.stateCookie) {
    res.cookies.set({
      name: SSO_STATE_COOKIE, value: out.stateCookie, httpOnly: true, secure: base.startsWith('https://'),
      // 계정 서비스에서 돌아오는 것은 다른 사이트에서 온 최상위 이동(GET)이라 lax로 실린다
      sameSite: 'lax', path: '/api/sso', maxAge: Math.floor(SSO_STATE_TTL_MS / 1000),
    });
  }
  return res;
}
