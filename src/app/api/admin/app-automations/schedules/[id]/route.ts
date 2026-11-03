import { NextRequest, NextResponse } from 'next/server';
import { getServerAuthSession, isAdminSession } from '@/lib/auth';
import { getActorScope } from '@/lib/actor-scope';
import { parseAdminReason, pauseScheduleByAdmin, unlockScheduleByAdmin } from '@/lib/apps/automation-admin';

export const dynamic = 'force-dynamic';
const fail = (message: string, status: number) => NextResponse.json({ ok: false, error: { message } }, { status });
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * 관리자 예약 조치 — `{ action: 'pause' | 'unlock', reason }`. 관리 범위 직원의 예약만, 사유 5자 이상, 보안 로그에 남는다.
 * pause는 직원이 다시 켜지 못하게 잠그고, unlock은 잠금만 푼다(예약은 멈춘 채 — 다시 켜는 것은 직원)
 */
export async function PATCH(request: NextRequest, { params }: { params: { id: string } }) {
  const session = await getServerAuthSession();
  if (!session?.user?.id) return fail('인증이 필요합니다.', 401);
  if (!isAdminSession(session)) return fail('관리자 권한이 필요합니다.', 403);
  if (!UUID.test(params.id)) return fail('예약을 확인해 주세요.', 400);
  const body = await request.json().catch(() => null) as { action?: unknown; reason?: unknown } | null;
  const action = body?.action;
  if (action !== 'pause' && action !== 'unlock') return fail('할 일은 pause 또는 unlock입니다.', 400);
  const reason = parseAdminReason(body?.reason);
  if (!reason.ok) return fail(reason.message, 400);
  const actor = await getActorScope(session);
  if (!actor) return fail('관리 범위를 확인할 수 없습니다.', 403);
  const admin = { scope: actor, userId: session.user.id, impersonating: Boolean(session.user.isImpersonating) };
  const result = action === 'pause'
    ? await pauseScheduleByAdmin(admin, params.id, reason.reason, Date.now())
    : await unlockScheduleByAdmin(admin, params.id, reason.reason, Date.now());
  if (!result.ok) return fail(result.message, result.status);
  return NextResponse.json({ ok: true, data: result.data });
}
