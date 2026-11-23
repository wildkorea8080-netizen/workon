import { NextRequest, NextResponse } from 'next/server';
import { getServerAuthSession } from '@/lib/auth';
import { supabaseAdmin } from '@/lib/supabaseAdmin';
import { clientIpFrom, isIpAllowed } from '@/lib/ip-access';
import { logSecurityEvent } from '@/lib/security-log';
import { logSystem } from '@/lib/logger';

/**
 * 소속·허용 IP를 못 읽어 차단 기록을 남기지 못했을 때(2026-11-20) — 예전엔 '기록할 것 없음'(ok, logged: false)으로 끝나
 * 차단된 접속이 감사 기록에서 빠진 것을 알 길이 없었다. 운영 기록에 단계·오류 코드만 남기고 503으로 답한다.
 */
async function unread(stage: 'user' | 'department' | 'organization', code: string | undefined, userId: string) {
  await logSystem({
    level: 'error', category: 'security', message: '접속 차단 기록을 남기지 못했습니다(소속·허용 IP를 읽지 못함)',
    details: { stage, code: code ?? 'error', user_id: userId },
  }).catch(() => {});
  return NextResponse.json({ ok: false, error: { message: '접속 차단 기록을 지금 남기지 못했습니다.' } }, { status: 503 });
}

export const dynamic = 'force-dynamic';

/**
 * 접속 차단 기록.
 *
 * 미들웨어는 Edge Runtime이라 서비스 키를 쓸 수 없어 `security_logs`에
 * 직접 넣지 못합니다. 그래서 차단 화면(`/blocked`)이 이 라우트를 부릅니다.
 *
 * **부르는 쪽을 믿지 않습니다.** 이 라우트가 IP를 다시 구해 허용 목록과
 * 다시 대조하고, 실제로 차단 상태일 때만 기록합니다. 그러지 않으면 아무나
 * 이 주소를 두드려 감사 기록을 가짜로 채울 수 있습니다.
 *
 * 감사에서 "누가 언제 어디서 막혔는가"를 실제로 묻습니다. 차단만 하고
 * 기록이 없으면 통제가 동작했다는 것을 증명할 수 없습니다.
 */
export async function POST(request: NextRequest) {
  try {
    const session = await getServerAuthSession();
    if (!session?.user?.id) {
      return NextResponse.json(
        { ok: false, error: { message: '인증이 필요합니다.' } },
        { status: 401 }
      );
    }

    let departmentId = session.user.departmentId ?? null;
    if (!departmentId) {
      const { data, error } = await supabaseAdmin
        .from('users')
        .select('department_id')
        .eq('id', session.user.id)
        .maybeSingle();
      if (error) return unread('user', error.code, session.user.id);
      departmentId = data?.department_id ?? null;
    }
    if (!departmentId) {
      return NextResponse.json({ ok: true, data: { logged: false } });
    }

    const { data: dept, error: deptError } = await supabaseAdmin
      .from('departments')
      .select('organization_id')
      .eq('id', departmentId)
      .maybeSingle();
    if (deptError) return unread('department', deptError.code, session.user.id);

    if (!dept?.organization_id) {
      return NextResponse.json({ ok: true, data: { logged: false } });
    }

    const { data: org, error: orgError } = await supabaseAdmin
      .from('organizations')
      .select('allowed_ips')
      .eq('id', dept.organization_id)
      .maybeSingle();
    if (orgError) return unread('organization', orgError.code, session.user.id);

    const allowed: string[] = org?.allowed_ips ?? [];
    const ip = clientIpFrom(request.headers, request.ip);

    // 실제로 막힌 상태가 아니면 남기지 않는다. 이 검사가 없으면 이 주소가
    // 감사 기록을 채워 넣는 통로가 된다.
    if (allowed.length === 0 || isIpAllowed(ip, allowed)) {
      return NextResponse.json({ ok: true, data: { logged: false } });
    }

    const logged = await logSecurityEvent(departmentId, session.user.id, 'ip_blocked', {
      ip,
      // 어떤 대역이 걸려 있었는지 함께 남긴다. 나중에 목록이 바뀌면
      // 그때 왜 막혔는지 알 수 없게 된다.
      allowed_at_the_time: allowed,
    }, 'high');

    return NextResponse.json({ ok: true, data: { logged } });
  } catch (error) {
    console.error('[access-denied]', error);
    // 기록 실패가 화면을 깨뜨릴 이유는 없다
    return NextResponse.json({ ok: true, data: { logged: false } });
  }
}
