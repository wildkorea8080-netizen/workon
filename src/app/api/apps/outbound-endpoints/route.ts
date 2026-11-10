import { NextResponse } from 'next/server';
import { getServerAuthSession } from '@/lib/auth';
import { getActorScope } from '@/lib/actor-scope';
import { listUsableEndpoints } from '@/lib/apps/outbound/admin';

export const dynamic = 'force-dynamic';
const fail = (message: string, status: number) => NextResponse.json({ ok: false, error: { message } }, { status });

/** 앱 빌더가 고를 수 있는 결과 보낼 곳(0076) — 이 기관의 회수되지 않은 곳, 이름만(주소·비밀값은 싣지 않는다) */
export async function GET() {
  const session = await getServerAuthSession();
  if (!session?.user?.id) return fail('인증이 필요합니다.', 401);
  const actor = await getActorScope(session).catch(() => null);
  if (!actor?.organizationId) return fail('소속 기관을 확인할 수 없습니다.', 403);
  const endpoints = await listUsableEndpoints(actor.organizationId);
  if (!endpoints) return fail('보낼 곳 목록을 불러오지 못했습니다.', 503);
  return NextResponse.json({ ok: true, data: endpoints });
}
