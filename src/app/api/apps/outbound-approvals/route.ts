import { NextResponse } from 'next/server';
import { getServerAuthSession } from '@/lib/auth';
import { getActorScope } from '@/lib/actor-scope';
import { listMyApprovals } from '@/lib/apps/outbound/approval';

export const dynamic = 'force-dynamic';
const fail = (message: string, status: number) => NextResponse.json({ ok: false, error: { message } }, { status });

/** 보내기 전 확인할 결과(0078) — 이 직원이 실행한 결과만(관리자도 남의 것은 보지 못한다). `?agent=`로 앱 하나만 */
export async function GET(request: Request) {
  const session = await getServerAuthSession();
  if (!session?.user?.id) return fail('인증이 필요합니다.', 401);
  const actor = await getActorScope(session).catch(() => null);
  if (!actor?.organizationId) return fail('소속 기관을 확인할 수 없습니다.', 403);
  const agent = new URL(request.url).searchParams.get('agent');
  const out = await listMyApprovals({ userId: session.user.id, organizationId: actor.organizationId, departmentId: actor.departmentId }, agent || null);
  if (!out.ok) return fail(out.message, out.status);
  return NextResponse.json({ ok: true, data: out.items });
}
