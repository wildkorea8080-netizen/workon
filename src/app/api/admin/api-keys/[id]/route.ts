import { NextResponse } from 'next/server';
import { getServerAuthSession, isAdminSession } from '@/lib/auth';
import { getActorScope } from '@/lib/actor-scope';
import { revokeOrgApiKey } from '@/lib/org-api/admin';

export const dynamic = 'force-dynamic';

function jsonError(message: string, status: number) {
  return NextResponse.json({ ok: false, error: { message } }, { status });
}

/** 기관 통계 API 키 회수(0075) — 기관 전체 관리자만, 이 기관의 쓸 수 있는 키만. 되돌릴 수 없다(새 키를 만든다) */
export async function DELETE(_request: Request, { params }: { params: { id: string } }) {
  try {
    const session = await getServerAuthSession();
    if (!isAdminSession(session)) return jsonError('관리자 권한이 필요합니다.', 403);
    const out = await revokeOrgApiKey((await getActorScope(session!))!, params.id);
    if (!out.ok) return jsonError(out.message, out.status);
    return NextResponse.json({ ok: true, data: { revoked: true } });
  } catch (error) {
    console.error('[admin api-keys DELETE]', error instanceof Error ? error.message : error);
    return jsonError('API 키를 회수하지 못했습니다.', 500);
  }
}
