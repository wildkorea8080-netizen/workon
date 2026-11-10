import { NextResponse } from 'next/server';
import { getServerAuthSession, isAdminSession } from '@/lib/auth';
import { getActorScope } from '@/lib/actor-scope';
import { createOutboundEndpoint, listOutbound } from '@/lib/apps/outbound/admin';

export const dynamic = 'force-dynamic';

function jsonError(message: string, status: number) {
  return NextResponse.json({ ok: false, error: { message } }, { status });
}

/** 앱 결과 보낼 곳(0076) 목록과 최근 보내기 기록 — 기관 전체 관리자만(결과 글은 싣지 않는다) */
export async function GET() {
  try {
    const session = await getServerAuthSession();
    if (!isAdminSession(session)) return jsonError('관리자 권한이 필요합니다.', 403);
    const out = await listOutbound((await getActorScope(session!))!);
    if (!out.ok) return jsonError(out.message, out.status);
    return NextResponse.json({ ok: true, data: { endpoints: out.endpoints, deliveries: out.deliveries } });
  } catch (error) {
    console.error('[admin outbound GET]', error instanceof Error ? error.message : error);
    return jsonError('보낼 곳 목록을 불러오지 못했습니다.', 500);
  }
}

/** 보낼 곳 만들기 — 서명 비밀값은 이 응답에서 한 번만 보인다 */
export async function POST(request: Request) {
  try {
    const session = await getServerAuthSession();
    if (!isAdminSession(session)) return jsonError('관리자 권한이 필요합니다.', 403);
    const body = await request.json().catch(() => null);
    const out = await createOutboundEndpoint((await getActorScope(session!))!, body);
    if (!out.ok) return jsonError(out.message, out.status);
    return NextResponse.json({ ok: true, data: { endpoint: out.endpoint, secret: out.secret } });
  } catch (error) {
    console.error('[admin outbound POST]', error instanceof Error ? error.message : error);
    return jsonError('보낼 곳을 만들지 못했습니다.', 500);
  }
}
