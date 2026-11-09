import { NextRequest, NextResponse } from 'next/server';
import { getServerAuthSession, isAdminSession } from '@/lib/auth';
import { getActorScope } from '@/lib/actor-scope';
import { createOrgApiKey, listOrgApiKeys } from '@/lib/org-api/admin';

export const dynamic = 'force-dynamic';

function jsonError(message: string, status: number) {
  return NextResponse.json({ ok: false, error: { message } }, { status });
}

/**
 * 기관 통계 API 키(0075) — 기관 전체 관리자만. GET 목록(해시 없음)·최근 호출 50개, POST 만들기(`{ name, scopes, days }` —
 * 키 원문은 이 응답에서 한 번만 보인다). 대리 접근 세션은 만들 수 없다(키가 대리 접근을 넘어 남는다)
 */
export async function GET() {
  try {
    const session = await getServerAuthSession();
    if (!isAdminSession(session)) return jsonError('관리자 권한이 필요합니다.', 403);
    const out = await listOrgApiKeys((await getActorScope(session!))!);
    if (!out.ok) return jsonError(out.message, out.status);
    return NextResponse.json({ ok: true, data: { keys: out.keys, calls: out.calls } });
  } catch (error) {
    console.error('[admin api-keys GET]', error instanceof Error ? error.message : error);
    return jsonError('API 키 목록을 불러오지 못했습니다.', 500);
  }
}

export async function POST(request: NextRequest) {
  try {
    const session = await getServerAuthSession();
    if (!isAdminSession(session)) return jsonError('관리자 권한이 필요합니다.', 403);
    if ((session!.user as { isImpersonating?: boolean }).isImpersonating) return jsonError('대리 접근 중에는 API 키를 만들 수 없습니다.', 403);
    const actor = await getActorScope(session!);
    const out = await createOrgApiKey(actor!, await request.json().catch(() => null));
    if (!out.ok) return jsonError(out.message, out.status);
    return NextResponse.json({ ok: true, data: { key: out.key, token: out.token } }, { headers: { 'Cache-Control': 'no-store' } });
  } catch (error) {
    console.error('[admin api-keys POST]', error instanceof Error ? error.message : error);
    return jsonError('API 키를 만들지 못했습니다.', 500);
  }
}
