import { NextRequest, NextResponse } from 'next/server';
import { NEXTAUTH_SECRET } from '@/lib/config';
import { clientIpFrom } from '@/lib/ip-access';
import { appBaseUrl, defaultSsoIo, finishSso, sessionCookieName, SSO_SESSION_MAX_AGE_S, SSO_STATE_COOKIE } from '@/lib/org-sso';

export const dynamic = 'force-dynamic';

/**
 * 기관 SSO 돌아옴(0107) — 계정 서비스가 보낸 code·state를 확인해 id_token을 검증하고, 이 기관에 등록된 직원이면 세션 쿠키를 만든다.
 * 상태 쿠키는 한 번 쓰면 지운다. 실패는 로그인 화면으로 까닭(`?error=sso_…`)과 함께
 */
export async function GET(request: NextRequest) {
  const base = appBaseUrl() || request.nextUrl.origin;
  const io = defaultSsoIo({ ip: clientIpFrom(request.headers, request.ip), userAgent: request.headers.get('user-agent') });
  const out = await finishSso(request.nextUrl.searchParams, request.cookies.get(SSO_STATE_COOKIE)?.value, io, base, NEXTAUTH_SECRET);
  const res = NextResponse.redirect(new URL(out.redirect, base), 302);
  res.headers.set('Cache-Control', 'no-store');
  res.cookies.set({ name: SSO_STATE_COOKIE, value: '', maxAge: 0, path: '/api/sso' });
  if (out.session) {
    res.cookies.set({
      name: sessionCookieName(base), value: out.session, httpOnly: true, secure: base.startsWith('https://'),
      sameSite: 'lax', path: '/', maxAge: SSO_SESSION_MAX_AGE_S,
    });
  }
  return res;
}
