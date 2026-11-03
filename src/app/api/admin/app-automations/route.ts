import { NextResponse } from 'next/server';
import { getServerAuthSession, isAdminSession } from '@/lib/auth';
import { getActorScope } from '@/lib/actor-scope';
import { listAdminAutomations } from '@/lib/apps/automation-admin';

export const dynamic = 'force-dynamic';
const fail = (message: string, status: number) => NextResponse.json({ ok: false, error: { message } }, { status });

/** 관리 범위 직원의 앱 예약·연동 목록(`src/lib/apps/automation-admin.ts`) — 입력값·결과·토큰은 싣지 않는다 */
export async function GET() {
  const session = await getServerAuthSession();
  if (!session?.user?.id) return fail('인증이 필요합니다.', 401);
  if (!isAdminSession(session)) return fail('관리자 권한이 필요합니다.', 403);
  const actor = await getActorScope(session);
  if (!actor) return fail('관리 범위를 확인할 수 없습니다.', 403);
  const result = await listAdminAutomations(actor, Date.now());
  if (!result.ok) return fail(result.message, result.status);
  return NextResponse.json({ ok: true, data: result.data });
}
