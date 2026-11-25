// src/lib/my-library-actor.ts
// 자료함 라우트의 요청자 — 세션 → 소속(actorScopeOr503) → 지금 부서가 든 공유 자료함(0116). 라우트마다 같은 길로.
import { NextResponse } from 'next/server';
import type { getServerAuthSession } from '@/lib/auth';
import { actorScopeOr503 } from '@/lib/actor-scope-response';
import { loadLibraryShares, LIBRARY_RETRY, type LibraryActor } from '@/lib/my-library';

function jsonError(message: string, status: number) {
  return NextResponse.json({ ok: false, error: { message } }, { status });
}

/** 자료함 요청자 — 로그인·소속 기관이 없으면 401·403, 공유 자료함 목록을 못 읽으면 503(못 읽은 것을 '든 곳 없음'으로 보지 않는다) */
export async function libraryActorOr(session: Awaited<ReturnType<typeof getServerAuthSession>>): Promise<LibraryActor | Response> {
  if (!session?.user?.id) return jsonError('인증이 필요합니다.', 401);
  // 소속을 모르면 거절한다 — 추측해서 배정하지 않는다
  const actor = await actorScopeOr503(session);
  if (actor instanceof Response) return actor;
  if (!actor?.organizationId) return jsonError('소속 기관을 확인할 수 없습니다.', 403);
  let shares: LibraryActor['shares'];
  try {
    shares = await loadLibraryShares(actor.organizationId, actor.departmentId);
  } catch {
    return jsonError(LIBRARY_RETRY, 503);
  }
  return {
    userId: actor.userId, organizationId: actor.organizationId, departmentId: actor.departmentId,
    isAdmin: actor.isAdmin, managesWholeOrganization: actor.managesWholeOrganization, shares,
  };
}
