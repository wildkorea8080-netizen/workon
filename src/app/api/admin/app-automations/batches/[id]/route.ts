import { NextRequest, NextResponse } from 'next/server';
import { getServerAuthSession, isAdminSession } from '@/lib/auth';
import { getActorScope } from '@/lib/actor-scope';
import { parseAdminReason, stopBatchByAdmin } from '@/lib/apps/automation-admin';

export const dynamic = 'force-dynamic';
const fail = (message: string, status: number) => NextResponse.json({ ok: false, error: { message } }, { status });
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * 관리자 일괄 실행 조치(2026-11-10) — `{ action: 'stop', reason }`. 관리 범위 직원의 실행 중인 일괄 실행만, 사유 5자 이상, 보안 로그·직원 메일.
 * 기다리던 줄은 건너뛰고 실행 중인 줄은 끝까지 간다. 되돌릴 수 없다
 */
export async function PATCH(request: NextRequest, { params }: { params: { id: string } }) {
  const session = await getServerAuthSession();
  if (!session?.user?.id) return fail('인증이 필요합니다.', 401);
  if (!isAdminSession(session)) return fail('관리자 권한이 필요합니다.', 403);
  if (!UUID.test(params.id)) return fail('일괄 실행을 확인해 주세요.', 400);
  const body = await request.json().catch(() => null) as { action?: unknown; reason?: unknown } | null;
  if (body?.action !== 'stop') return fail('할 일은 stop입니다.', 400);
  const reason = parseAdminReason(body?.reason);
  if (!reason.ok) return fail(reason.message, 400);
  const actor = await getActorScope(session);
  if (!actor) return fail('관리 범위를 확인할 수 없습니다.', 403);
  const result = await stopBatchByAdmin({ scope: actor, userId: session.user.id, impersonating: Boolean(session.user.isImpersonating) }, params.id, reason.reason, Date.now());
  if (!result.ok) return fail(result.message, result.status);
  return NextResponse.json({ ok: true, data: result.data });
}
