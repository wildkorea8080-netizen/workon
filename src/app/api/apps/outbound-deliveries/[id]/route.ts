import { NextResponse } from 'next/server';
import { getServerAuthSession } from '@/lib/auth';
import { getActorScope } from '@/lib/actor-scope';
import { retryMyDelivery } from '@/lib/apps/outbound/deliver';

export const dynamic = 'force-dynamic';
const fail = (message: string, status: number) => NextResponse.json({ ok: false, error: { message } }, { status });

/** 그만둔 보내기 다시 보내기(2026-11-10) — `{ action: 'retry' }`. 그 결과를 실행한 직원만, 실제로 보내 보고 그만둔 7일 안의 기록만 */
export async function POST(request: Request, { params }: { params: { id: string } }) {
  const session = await getServerAuthSession();
  if (!session?.user?.id) return fail('인증이 필요합니다.', 401);
  const body = (await request.json().catch(() => null)) as { action?: unknown } | null;
  if (body?.action !== 'retry') return fail('할 일은 retry입니다.', 400);
  const actor = await getActorScope(session).catch(() => null);
  if (!actor?.organizationId) return fail('소속 기관을 확인할 수 없습니다.', 403);
  const out = await retryMyDelivery({ userId: session.user.id, organizationId: actor.organizationId, departmentId: actor.departmentId }, params.id);
  if (!out.ok) return fail(out.message, out.status);
  return NextResponse.json({ ok: true, data: { retried: true } });
}
