import { NextResponse } from 'next/server';
import { getServerAuthSession } from '@/lib/auth';
import { getActorScope } from '@/lib/actor-scope';
import { listMyDeliveries } from '@/lib/apps/outbound/deliver';

export const dynamic = 'force-dynamic';
const fail = (message: string, status: number) => NextResponse.json({ ok: false, error: { message } }, { status });

/** 이 직원이 실행한 결과의 보낸 기록(0080) — 상태·받는 쪽 접수 번호·주소. 요청자의 것만(관리자도 남의 것은 이 길로 못 본다). `?agent=`로 앱 하나만 */
export async function GET(request: Request) {
  const session = await getServerAuthSession();
  if (!session?.user?.id) return fail('인증이 필요합니다.', 401);
  const actor = await getActorScope(session).catch(() => null);
  if (!actor?.organizationId) return fail('소속 기관을 확인할 수 없습니다.', 403);
  const agent = new URL(request.url).searchParams.get('agent');
  const out = await listMyDeliveries({ userId: session.user.id, organizationId: actor.organizationId }, agent || null);
  if (!out.ok) return fail(out.message, out.status);
  return NextResponse.json({ ok: true, data: out.items });
}
