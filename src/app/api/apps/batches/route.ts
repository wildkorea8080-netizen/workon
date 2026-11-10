import { NextRequest, NextResponse } from 'next/server';
import { getServerAuthSession } from '@/lib/auth';
import { getActorScope } from '@/lib/actor-scope';
import { createBatch, listBatches } from '@/lib/apps/batches';

export const dynamic = 'force-dynamic';
const fail = (message: string, status: number, extra: Record<string, unknown> = {}) => NextResponse.json({ ok: false, error: { message, ...extra } }, { status });

/** 내 일괄 실행(0077) 최근 20개 — `?agent=`면 그 앱만. 요청자의 것만 */
export async function GET(request: NextRequest) {
  const session = await getServerAuthSession();
  if (!session?.user?.id) return fail('인증이 필요합니다.', 401);
  const list = await listBatches(session.user.id, request.nextUrl.searchParams.get('agent'));
  if (!list) return fail('일괄 실행을 불러오지 못했습니다.', 503);
  return NextResponse.json({ ok: true, data: list });
}

/** 일괄 실행 만들기 — `{ agent_id, name?, rows: [{항목 키: 값}] }`, 줄마다 앱 규칙으로 다시 검사 */
export async function POST(request: NextRequest) {
  const session = await getServerAuthSession();
  if (!session?.user?.id) return fail('인증이 필요합니다.', 401);
  const actor = await getActorScope(session).catch(() => null);
  if (!actor) return fail('소속을 확인할 수 없습니다.', 403);
  const body = await request.json().catch(() => null);
  const out = await createBatch(actor, body);
  if (!out.ok) return fail(out.message, out.status, 'errors' in out ? { details: { errors: out.errors } } : {});
  return NextResponse.json({ ok: true, data: out.batch });
}
