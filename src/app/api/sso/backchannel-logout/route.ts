import { NextResponse } from 'next/server';
import { defaultSsoBackchannelIo, handleBackchannelLogout, LOGOUT_TOKEN_MAX_LENGTH } from '@/lib/org-sso';

export const dynamic = 'force-dynamic';

const NO_STORE = { 'Cache-Control': 'no-store' };

/**
 * 기관 SSO back-channel 로그아웃(0114) — 계정 서비스가 서버끼리 보내는 OIDC Back-Channel Logout 요청(폼 `logout_token`).
 * 로그인 없이 열린다 — 계정 서비스가 서명한 logout_token(그 기관 SSO 설정의 발급자·클라이언트 ID, jwks 공개키)이 유일한 자격이다.
 * 맞으면 그 사람의 '기관 계정 로그아웃 시각'을 적고 200, 틀린 토큰 400, 못 읽음 503(계정 서비스가 다시 보낸다).
 * 이 라우트는 세션을 만들지도 바꾸지도 않는다 — 끝내는 일은 미들웨어가 한다
 */
export async function POST(request: Request) {
  let token: string | null = null;
  const type = request.headers.get('content-type') ?? '';
  if (type.toLowerCase().includes('application/x-www-form-urlencoded')) {
    try {
      const body = await request.text();
      if (body.length <= LOGOUT_TOKEN_MAX_LENGTH + 100) token = new URLSearchParams(body).get('logout_token');
    } catch {
      token = null;
    }
  }
  const out = await handleBackchannelLogout(token, defaultSsoBackchannelIo());
  if (out.status === 200) return NextResponse.json({ ok: true, data: { ended: out.ended } }, { headers: NO_STORE });
  return NextResponse.json(
    { ok: false, error: { message: out.status === 503 ? '로그아웃 요청을 지금 처리하지 못했습니다. 잠시 뒤 다시 보내 주세요.' : '로그아웃 요청(logout_token)이 올바르지 않습니다.' } },
    { status: out.status, headers: NO_STORE },
  );
}
