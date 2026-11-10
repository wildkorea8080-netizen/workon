import { NextResponse } from 'next/server';
import { getServerAuthSession, isAdminSession } from '@/lib/auth';
import { getActorScope } from '@/lib/actor-scope';
import { revokeOutboundEndpoint } from '@/lib/apps/outbound/admin';

export const dynamic = 'force-dynamic';

function jsonError(message: string, status: number) {
  return NextResponse.json({ ok: false, error: { message } }, { status });
}

/** 보낼 곳 회수(0076) — 기관 전체 관리자만, 사유 5자 이상. 보내지 않은 기록은 그만둔다. 되돌릴 수 없다(새로 만든다) */
export async function DELETE(request: Request, { params }: { params: { id: string } }) {
  try {
    const session = await getServerAuthSession();
    if (!isAdminSession(session)) return jsonError('관리자 권한이 필요합니다.', 403);
    const body = (await request.json().catch(() => null)) as { reason?: unknown } | null;
    const out = await revokeOutboundEndpoint((await getActorScope(session!))!, params.id, body?.reason);
    if (!out.ok) return jsonError(out.message, out.status);
    return NextResponse.json({ ok: true, data: { revoked: true } });
  } catch (error) {
    console.error('[admin outbound DELETE]', error instanceof Error ? error.message : error);
    return jsonError('보낼 곳을 회수하지 못했습니다.', 500);
  }
}
