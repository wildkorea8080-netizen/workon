import { NextRequest, NextResponse } from 'next/server';
import { getServerAuthSession, isAdminSession } from '@/lib/auth';
import { actorScopeOr503 } from '@/lib/actor-scope-response';
import { parseAdminReason } from '@/lib/apps/automation-admin';
import { setOrgSwitch } from '@/lib/apps/webhook-switch';
import { BAD_BODY_MESSAGE, readJsonObject } from '@/lib/request-body';

export const dynamic = 'force-dynamic';
const fail = (message: string, status: number) => NextResponse.json({ ok: false, error: { message } }, { status });

/**
 * 기관 전체 '대화 공개 링크' 막기·다시 열기(0098, 2026-11-23) — `{ enabled: boolean, reason }`.
 * 기관 전체를 관리하는 관리자만(`setOrgSwitch`가 본다), 사유 5~200자, 보안 로그(high).
 * 막으면 새 링크를 만들지 못하고 이미 만든 링크도 열리지 않는다. 링크는 지우지 않는다 — 다시 열면 그대로
 */
export async function PUT(request: NextRequest) {
  const session = await getServerAuthSession();
  if (!session?.user?.id) return fail('인증이 필요합니다.', 401);
  if (!isAdminSession(session)) return fail('관리자 권한이 필요합니다.', 403);
  const body = await readJsonObject(request);
  if (!body) return fail(BAD_BODY_MESSAGE, 400);
  if (typeof body.enabled !== 'boolean') return fail('enabled(참·거짓)를 보내 주세요.', 400);
  const reason = parseAdminReason(body.reason);
  if (!reason.ok) return fail(reason.message, 400);
  const actor = await actorScopeOr503(session);
  if (actor instanceof Response) return actor;
  if (!actor) return fail('관리 범위를 확인할 수 없습니다.', 403);
  const result = await setOrgSwitch('shares', { scope: actor, userId: session.user.id, impersonating: Boolean(session.user.isImpersonating) }, body.enabled, reason.reason, Date.now());
  if (!result.ok) return fail(result.message, result.status);
  return NextResponse.json({ ok: true, data: result.data });
}
