import { NextResponse } from 'next/server';
import { getServerAuthSession, isAdminSession } from '@/lib/auth';
import { getActorScope } from '@/lib/actor-scope';
import { indexPendingDocuments } from '@/lib/document-references';
import { indexDeps } from '@/lib/document-references-db';

export const dynamic = 'force-dynamic';
// 원본 다섯 개를 차례로 다시 읽는다(시간 예산 40초)
export const maxDuration = 60;

function jsonError(message: string, status: number) {
  return NextResponse.json({ ok: false, error: { message } }, { status });
}

/**
 * 참조 색인 만들기(2026-11-09) — 요청자가 볼 수 있는 기관 문서 중 아직 색인 없는 것을 몇 개(5개·40초) 읽어 인용 이름의 열쇠를 남긴다.
 * 화면은 남은 것이 없거나 더 줄지 않을 때까지 다시 부른다. 모델을 부르지 않는다. 관리자만
 */
export async function POST() {
  const session = await getServerAuthSession();
  if (!session?.user?.id) return jsonError('로그인이 필요합니다.', 401);
  if (!isAdminSession(session)) return jsonError('관리자 권한이 필요합니다.', 403);
  const actor = await getActorScope(session);
  if (!actor?.organizationId) return jsonError('소속 기관을 확인할 수 없습니다.', 403);
  try {
    return NextResponse.json({ ok: true, data: await indexPendingDocuments(actor, indexDeps(actor)) });
  } catch (error) {
    console.error('[documents references index]', error instanceof Error ? error.message : error);
    return jsonError('참조 색인을 만드는 중 오류가 발생했습니다. 잠시 뒤 다시 시도해 주세요.', 503);
  }
}
