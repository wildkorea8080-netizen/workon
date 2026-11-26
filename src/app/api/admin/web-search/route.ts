import { NextRequest, NextResponse } from 'next/server';
import { getServerAuthSession, isAdminSession } from '@/lib/auth';
import { actorScopeOr503 } from '@/lib/actor-scope-response';
import { parseAdminReason } from '@/lib/apps/automation-admin';
import { readWebSearchSwitch, setWebSearchSwitch, webSearchSwitchView } from '@/lib/web-search-switch';
import { BAD_BODY_MESSAGE, readJsonObject } from '@/lib/request-body';

export const dynamic = 'force-dynamic';
const fail = (message: string, status: number) => NextResponse.json({ ok: false, error: { message } }, { status });

/** 기관 웹 검색 스위치(0124, 2026-11-26) — 보기는 관리자 누구나(`canChange`로 단추를 가름). 못 읽으면 503('꺼짐'으로 꾸미지 않는다) */
export async function GET() {
  const session = await getServerAuthSession();
  if (!session?.user?.id) return fail('인증이 필요합니다.', 401);
  if (!isAdminSession(session)) return fail('관리자 권한이 필요합니다.', 403);
  const actor = await actorScopeOr503(session);
  if (actor instanceof Response) return actor;
  if (!actor?.organizationId) return fail('기관 소속을 확인할 수 없습니다.', 403);
  try {
    return NextResponse.json({ ok: true, data: webSearchSwitchView(await readWebSearchSwitch(actor.organizationId), actor) });
  } catch {
    return fail('웹 검색 설정을 지금 읽지 못했습니다. 잠시 뒤 다시 시도해 주세요.', 503);
  }
}

/**
 * 켜기·끄기 — `{ enabled: boolean, reason }`. 기관 전체를 관리하는 관리자만(`setWebSearchSwitch`가 본다), 사유 5~200자, 보안 로그(high).
 * 켜면 웹 검색 능력을 켠 비서가 검색어를 Anthropic 웹 검색으로 보낸다
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
  const result = await setWebSearchSwitch({ scope: actor, userId: session.user.id, impersonating: Boolean(session.user.isImpersonating) }, body.enabled, reason.reason, Date.now());
  if (!result.ok) return fail(result.message, result.status);
  return NextResponse.json({ ok: true, data: result.data });
}
