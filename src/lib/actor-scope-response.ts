import { NextResponse } from 'next/server';
import type { Session } from 'next-auth';
import type { ActorScope } from '@/lib/agent-permissions';
import { getActorScope } from '@/lib/actor-scope';

/**
 * 라우트용 `getActorScope` — 소속을 못 읽으면(`ActorScopeReadError`) 503 응답을 돌려준다(2026-11-19).
 *
 * 0193부터 `getActorScope`는 사용자·부서 읽기 실패를 '소속 없음'(null)이 아니라 오류로 던진다. 그런데 try 밖에서 부르는
 * 라우트 서른여 곳은 그 오류가 처리기 밖으로 빠져 **빈 몸의 500**이 됐고, `.catch(() => null)`로 받던 곳은 읽기 실패를
 * 다시 '소속 없음'(403 '기관 소속을 확인할 수 없습니다')으로 답했다. 부르는 쪽:
 *
 *   const actor = await actorScopeOr503(session);
 *   if (actor instanceof Response) return actor;
 *
 * 그 밖의 오류는 그대로 던진다(라우트의 catch·플랫폼 500). 정말 소속이 없으면 지금처럼 null.
 */
export const ACTOR_SCOPE_RESPONSE_MESSAGE = '요청자 정보를 지금 확인하지 못했습니다. 잠시 뒤 다시 시도해 주세요.';

export async function actorScopeOr503(session: Session | null): Promise<ActorScope | null | NextResponse> {
  try {
    return await getActorScope(session);
  } catch (err) {
    // 시험의 가짜 모듈에 도우미가 없어도 되게 이름으로 가른다
    if (err instanceof Error && err.name === 'ActorScopeReadError') {
      return NextResponse.json({ ok: false, error: { message: ACTOR_SCOPE_RESPONSE_MESSAGE } }, { status: 503 });
    }
    throw err;
  }
}
