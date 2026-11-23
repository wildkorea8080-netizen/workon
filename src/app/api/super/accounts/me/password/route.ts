import { NextRequest, NextResponse } from 'next/server';
import { IS_PRODUCTION } from '@/lib/config';
import { getSuperAdminFromRequest, SUPER_COOKIE_NAME } from '@/lib/super-auth';
import { changeOwnPassword, passwordChangeDeps } from '@/lib/password-change';
import { LOCKED_MESSAGE, requestIp, throttleDeps } from '@/lib/sign-in-throttle';
import { writeAuditRow } from '@/lib/audit-write';

export const dynamic = 'force-dynamic';

/**
 * 슈퍼관리자 본인 비밀번호 바꾸기 — 2026-11-17부터 직원과 같은 길(`changeOwnPassword`).
 * 예전엔 8자만 보고, 지금 비밀번호를 틀려도 실패로 세지 않았고(쿠키만 있으면 끝없이 맞춰 볼 수 있음), Supabase Auth만 바꿔
 * `password_hash`가 있던 계정은 **옛 비밀번호가 직원 로그인 두 번째 길로 계속 통과**했으며, 다른 기기의 로그인도 그대로였다.
 * 이제: 규칙(`passwordPolicyError`), 틀리면 슈퍼관리자 로그인 실패로 셈(잠금), Auth·해시 둘 다 바꿈, 바꾼 때(0092)를 적어
 * 미들웨어가 그 전에 받은 슈퍼관리자 토큰·직원 로그인을 끝냄, 이 브라우저의 쿠키도 지움, 조작 기록(비밀번호 없음).
 */
export async function PATCH(request: NextRequest) {
  const admin = getSuperAdminFromRequest(request);
  if (!admin) return NextResponse.json({ ok: false, error: '인증 필요' }, { status: 401 });

  const body = (await request.json().catch(() => null)) as { currentPassword?: unknown; newPassword?: unknown } | null;
  const result = await changeOwnPassword(passwordChangeDeps(throttleDeps()), {
    userId: admin.sub,
    current: body?.currentPassword,
    next: body?.newPassword,
    ip: requestIp(request.headers),
    scope: 'super',
  });

  if (!result.ok) {
    const map: Record<typeof result.code, [number, string]> = {
      locked: [429, LOCKED_MESSAGE],
      wrong: [400, '현재 비밀번호가 올바르지 않습니다.'],
      same: [400, '지금 비밀번호와 다른 비밀번호를 입력해 주세요.'],
      policy: [400, '비밀번호 규칙에 맞지 않습니다.'],
      not_found: [403, '계정을 확인할 수 없습니다. 다시 로그인해 주세요.'],
      error: [500, '비밀번호를 바꾸지 못했습니다. 잠시 뒤 다시 시도해 주세요.'],
    };
    const [status, fallback] = map[result.code];
    return NextResponse.json({ ok: false, error: result.message ?? fallback, code: result.code }, { status });
  }

  await writeAuditRow('super_admin_logs', {
    admin_user_id: admin.sub,
    action: 'super_admin_password_changed',
    target_type: 'user',
    target_id: admin.sub,
    after_data: result.sessionsKept ? { sessions_kept: true } : {},
  }, 'super_admin_password_changed');

  // 바꾼 때를 적었으면 모든 슈퍼관리자 로그인이 끝난다 — 이 브라우저는 바로 끝내고 화면이 로그인으로 보낸다
  const signedOut = !result.sessionsKept;
  const res = NextResponse.json({ ok: true, data: { signedOut } });
  if (signedOut) {
    res.cookies.set({ name: SUPER_COOKIE_NAME, value: '', httpOnly: true, secure: IS_PRODUCTION, sameSite: 'lax', path: '/', maxAge: 0 });
  }
  return res;
}
