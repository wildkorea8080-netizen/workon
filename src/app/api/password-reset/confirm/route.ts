import { NextRequest, NextResponse } from 'next/server';
import { supabaseAdmin } from '@/lib/supabaseAdmin';
import { confirmPasswordReset, resetDeps } from '@/lib/password-reset-mail';

export const dynamic = 'force-dynamic';

/**
 * 직원 비밀번호 찾기 — 메일 링크로 새 비밀번호 정하기(2026-11-16, 0096). 로그인 전에 부르는 곳이라 세션이 없고,
 * 링크의 열쇠(32바이트 난수, DB에는 SHA-256만·30분·한 번)가 유일한 자격이다. 성공하면 그 계정의 모든 로그인이 끝나고
 * 로그인 실패 잠금이 풀린다. 보안 로그 `password_reset_by_email`(medium — 사람 id만, 비밀번호·열쇠 없음).
 */
export async function POST(request: NextRequest) {
  const body = await request.json().catch(() => null);
  const input = body && typeof body === 'object' ? (body as { token?: unknown; next?: unknown }) : {};
  const result = await confirmPasswordReset(resetDeps(), { token: input.token, next: input.next });
  if (!result.ok) {
    if (result.code === 'error') {
      return NextResponse.json({ ok: false, error: { message: '비밀번호를 바꾸지 못했습니다. 잠시 뒤 같은 링크로 다시 시도해 주세요.' } }, { status: 500 });
    }
    return NextResponse.json({ ok: false, error: { message: result.message ?? '요청을 처리하지 못했습니다.', code: result.code } }, { status: 400 });
  }
  try {
    await supabaseAdmin.from('security_logs').insert({
      department_id: result.departmentId,
      user_id: result.userId,
      event_type: 'password_reset_by_email',
      details: result.sessionsKept ? { sessions_kept: true } : {},
      severity: 'medium',
      created_at: new Date().toISOString(),
    });
  } catch { /* 보안 로그 실패는 바꾸기를 되돌리지 않는다 */ }
  return NextResponse.json({ ok: true, data: {} });
}
