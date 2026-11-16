import { NextRequest, NextResponse } from 'next/server';
import { requestPasswordReset, resetDeps } from '@/lib/password-reset-mail';
import { RESET_REQUESTED_MESSAGE } from '@/lib/password-reset-spec';
import { requestIp } from '@/lib/sign-in-throttle';

export const dynamic = 'force-dynamic';

/**
 * 직원 비밀번호 찾기 — 재설정 링크 요청(2026-11-16, 0096, `src/lib/password-reset-mail.ts`). 로그인 전에 부르는 곳이라 인증이 없다.
 * 계정이 있든 없든 같은 응답이다(등록 여부를 알아내는 통로가 되지 않게). IP마다 1시간 10번을 넘으면 429, 메일이 설정되지 않은 배포는 503.
 */
export async function POST(request: NextRequest) {
  const body = await request.json().catch(() => null);
  const result = await requestPasswordReset(resetDeps(), {
    email: body && typeof body === 'object' ? (body as { email?: unknown }).email : undefined,
    ip: requestIp(request.headers),
  });
  if (result.ok) return NextResponse.json({ ok: true, data: { message: RESET_REQUESTED_MESSAGE } });
  if (result.code === 'mail_off') {
    return NextResponse.json({ ok: false, error: { message: '메일 보내기가 설정되지 않아 비밀번호를 찾을 수 없습니다. 기관 관리자에게 임시 비밀번호 재발급을 요청해 주세요.' } }, { status: 503 });
  }
  if (result.code === 'ip_limited') {
    return NextResponse.json({ ok: false, error: { message: '요청이 너무 많습니다. 1시간 뒤 다시 시도해 주세요.' } }, { status: 429 });
  }
  return NextResponse.json({ ok: false, error: { message: '지금 요청을 받지 못했습니다. 잠시 뒤 다시 시도해 주세요.' } }, { status: 500 });
}
