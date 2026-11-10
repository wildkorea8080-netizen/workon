import { NextResponse } from 'next/server';
import { getServerAuthSession } from '@/lib/auth';
import { getActorScope } from '@/lib/actor-scope';
import { decideApproval } from '@/lib/apps/outbound/approval';
import { parseDecision } from '@/lib/apps/outbound/spec';

export const dynamic = 'force-dynamic';
const fail = (message: string, status: number) => NextResponse.json({ ok: false, error: { message } }, { status });

/** 결과를 보낼지 정한다(0078) — 몸 `{ decision: 'approve' | 'reject' }`. 그 결과를 실행한 직원만 */
export async function POST(request: Request, { params }: { params: { id: string } }) {
  const session = await getServerAuthSession();
  if (!session?.user?.id) return fail('인증이 필요합니다.', 401);
  const decision = parseDecision(await request.json().catch(() => null));
  if (!decision) return fail("보낼지(approve) 보내지 않을지(reject) 정해 주세요.", 400);
  const actor = await getActorScope(session).catch(() => null);
  if (!actor?.organizationId) return fail('소속 기관을 확인할 수 없습니다.', 403);
  const out = await decideApproval({ userId: session.user.id, organizationId: actor.organizationId, departmentId: actor.departmentId }, params.id, decision);
  if (!out.ok) return fail(out.message, out.status);
  return NextResponse.json({ ok: true, data: { status: out.status } });
}
