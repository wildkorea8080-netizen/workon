import { NextRequest, NextResponse } from 'next/server';
import { getServerAuthSession, isAdminSession } from '@/lib/auth';
import { getActorScope } from '@/lib/actor-scope';
import { parseAdminReason } from '@/lib/apps/automation-admin';
import { parseBatchLimit, setBatchLimit } from '@/lib/apps/batch-limit';

export const dynamic = 'force-dynamic';
const fail = (message: string, status: number) => NextResponse.json({ ok: false, error: { message } }, { status });

/** 기관의 일괄 실행 한 번 최대 줄 수(0084) — `{ max_rows: 1~100 | null, reason }`. 기관 전체 관리자만, 사유 5~200자, 보안 로그(high) */
export async function PUT(request: NextRequest) {
  const session = await getServerAuthSession();
  if (!session?.user?.id) return fail('인증이 필요합니다.', 401);
  if (!isAdminSession(session)) return fail('관리자 권한이 필요합니다.', 403);
  const body = await request.json().catch(() => null) as { max_rows?: unknown; reason?: unknown } | null;
  const value = parseBatchLimit(body?.max_rows === undefined ? undefined : body.max_rows);
  if (!value.ok) return fail(value.message, 400);
  const reason = parseAdminReason(body?.reason);
  if (!reason.ok) return fail(reason.message, 400);
  const actor = await getActorScope(session);
  if (!actor) return fail('관리 범위를 확인할 수 없습니다.', 403);
  const result = await setBatchLimit({ scope: actor, userId: session.user.id, impersonating: Boolean(session.user.isImpersonating) }, value.value, reason.reason);
  if (!result.ok) return fail(result.message, result.status);
  return NextResponse.json({ ok: true, data: result.data });
}
