import { NextResponse } from 'next/server';
import { getServerAuthSession } from '@/lib/auth';
import { libraryActorOr } from '@/lib/my-library-actor';

export const dynamic = 'force-dynamic';

/** 내가 든 공유 자료함(0116) — 지금 소속 부서가 든 것만, 이름과 id. '지난 파일'이 탭을 만든다. 못 읽으면 503 */
export async function GET() {
  const actor = await libraryActorOr(await getServerAuthSession());
  if (actor instanceof Response) return actor;
  return NextResponse.json({ ok: true, data: actor.shares ?? [] });
}
