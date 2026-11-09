import { NextRequest, NextResponse } from 'next/server';
import { getServerAuthSession, isAdminSession } from '@/lib/auth';
import { getActorScope } from '@/lib/actor-scope';
import { documentReferences } from '@/lib/document-references';
import { referenceDeps } from '@/lib/document-references-db';

export const dynamic = 'force-dynamic';
// 큰 한글·엑셀 원본을 다시 읽는다(스캔 PDF는 NODA로 보내지 않는다)
export const maxDuration = 60;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function jsonError(message: string, status: number) {
  return NextResponse.json({ ok: false, error: { message } }, { status });
}

/**
 * 문서 참조 관계(2026-11-08) — 문서 원본에서 「…」·『…』로 인용한 이름을 찾아 기관 문서(요청자가 볼 수 있는 비서 문서)·
 * 기관 유형의 공통 자료실과 맞춘다. (2026-11-09) 그 결과를 이 문서의 참조 색인(`metadata.references`)으로 남기고,
 * 색인으로 '이 문서를 인용하는 문서'도 돌려준다. 모델을 부르지 않는다. 관리자만(문서 화면), 볼 수 없는 문서는 404
 */
export async function GET(_request: NextRequest, { params }: { params: { id: string } }) {
  const session = await getServerAuthSession();
  if (!session?.user?.id) return jsonError('로그인이 필요합니다.', 401);
  if (!isAdminSession(session)) return jsonError('관리자 권한이 필요합니다.', 403);
  const actor = await getActorScope(session);
  if (!actor?.organizationId) return jsonError('소속 기관을 확인할 수 없습니다.', 403);
  if (!UUID.test(params.id)) return jsonError('문서를 찾을 수 없습니다.', 404);
  try {
    const outcome = await documentReferences(params.id, actor, referenceDeps(actor));
    if (!outcome.ok) return jsonError(outcome.message, outcome.status);
    return NextResponse.json({ ok: true, data: outcome.data }, { headers: { 'Cache-Control': 'private, no-store' } });
  } catch (error) {
    console.error('[documents references]', params.id, error instanceof Error ? error.message : error);
    return jsonError('참조 문서를 찾는 중 오류가 발생했습니다. 잠시 뒤 다시 시도해 주세요.', 503);
  }
}
