import { NextRequest, NextResponse } from 'next/server';
import { getServerAuthSession, isAdminSession } from '@/lib/auth';
import { getActorScope } from '@/lib/actor-scope';
import { parseAdminReason } from '@/lib/apps/automation-admin';
import { setWebhookSwitch } from '@/lib/apps/webhook-switch';

export const dynamic = 'force-dynamic';
const fail = (message: string, status: number) => NextResponse.json({ ok: false, error: { message } }, { status });

/**
 * 기관 전체 외부 연동(Webhook) 끄기·켜기(0068) — `{ enabled: boolean, reason }`. 기관 전체를 관리하는 관리자만(`setWebhookSwitch`가 본다),
 * 사유 5~200자, 보안 로그(high)에 남는다. 토큰은 회수하지 않는다
 */
export async function PUT(request: NextRequest) {
  const session = await getServerAuthSession();
  if (!session?.user?.id) return fail('인증이 필요합니다.', 401);
  if (!isAdminSession(session)) return fail('관리자 권한이 필요합니다.', 403);
  const body = await request.json().catch(() => null) as { enabled?: unknown; reason?: unknown } | null;
  if (typeof body?.enabled !== 'boolean') return fail('enabled(참·거짓)를 보내 주세요.', 400);
  const reason = parseAdminReason(body.reason);
  if (!reason.ok) return fail(reason.message, 400);
  const actor = await getActorScope(session);
  if (!actor) return fail('관리 범위를 확인할 수 없습니다.', 403);
  const result = await setWebhookSwitch({ scope: actor, userId: session.user.id, impersonating: Boolean(session.user.isImpersonating) }, body.enabled, reason.reason, Date.now());
  if (!result.ok) return fail(result.message, result.status);
  return NextResponse.json({ ok: true, data: result.data });
}
