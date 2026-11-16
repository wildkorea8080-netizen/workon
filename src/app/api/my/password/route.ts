import { NextRequest, NextResponse } from 'next/server';
import { getServerAuthSession } from '@/lib/auth';
import { supabaseAdmin } from '@/lib/supabaseAdmin';
import { changeOwnPassword, passwordChangeDeps } from '@/lib/password-change';
import { LOCKED_MESSAGE, requestIp, throttleDeps } from '@/lib/sign-in-throttle';
import { logSecurityEvent } from '@/lib/security-log';

export const dynamic = 'force-dynamic';

/**
 * 내 비밀번호 바꾸기(2026-11-16, `src/lib/password-change.ts`). 본인만 — 대상은 세션의 사용자 id뿐이고 요청값으로 받지 않는다.
 * 대리 접근(슈퍼관리자가 관리자로 들어옴) 중에는 그 관리자의 비밀번호를 바꾸지 못한다.
 * 지금 비밀번호를 틀리면 로그인 실패로 센다(30분 5번이면 잠김). 비밀번호는 어디에도 기록하지 않는다.
 */
export async function POST(request: NextRequest) {
  const session = await getServerAuthSession();
  if (!session?.user?.id) {
    return NextResponse.json({ ok: false, error: { message: '로그인이 필요합니다.' } }, { status: 401 });
  }
  if (session.user.isImpersonating) {
    return NextResponse.json({ ok: false, error: { message: '대리 접근 중에는 비밀번호를 바꿀 수 없습니다.' } }, { status: 403 });
  }

  let body: { current?: unknown; next?: unknown };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ ok: false, error: { message: '요청 형식이 올바르지 않습니다.' } }, { status: 400 });
  }

  const result = await changeOwnPassword(passwordChangeDeps(throttleDeps()), {
    userId: session.user.id,
    current: body?.current,
    next: body?.next,
    ip: requestIp(request.headers),
  });

  if (!result.ok) {
    const map: Record<typeof result.code, [number, string]> = {
      locked: [429, LOCKED_MESSAGE],
      wrong: [400, '지금 비밀번호가 맞지 않습니다.'],
      same: [400, '지금 비밀번호와 다른 비밀번호를 입력해 주세요.'],
      policy: [400, '비밀번호 규칙에 맞지 않습니다.'],
      not_found: [403, '계정을 확인할 수 없습니다. 다시 로그인해 주세요.'],
      error: [500, '비밀번호를 바꾸지 못했습니다. 잠시 뒤 다시 시도해 주세요.'],
    };
    const [status, fallback] = map[result.code];
    return NextResponse.json({ ok: false, error: { message: result.message ?? fallback, code: result.code } }, { status });
  }

  // 보안 로그 실패는 바꾸기를 되돌리지 않는다(실패는 운영 기록에 남는다)
  await logSecurityEvent(session.user.departmentId ?? null, session.user.id, 'password_changed', result.sessionsKept ? { sessions_kept: true } : {}, 'low');

  // 바꾼 때를 적었으면 이 브라우저를 포함한 모든 로그인이 곧 끝난다 — 화면이 로그아웃하고 로그인 화면으로 보낸다
  return NextResponse.json({ ok: true, data: { signedOut: !result.sessionsKept } });
}
