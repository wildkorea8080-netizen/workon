import { NextRequest, NextResponse } from 'next/server';
import { getServerAuthSession } from '@/lib/auth';
import { getActorScope } from '@/lib/actor-scope';
import { confirmUpload, isConversationOwner, listConversationAttachments, toClientRow } from '@/lib/attachments/store';

export const dynamic = 'force-dynamic';
// 확인 단계에서 파일을 내려받아 읽는다. 큰 XLSX와 스캔 PDF(NODA /parse — 시도 60초 + 재시도 창)는 시간이 든다.
// 60초면 플랫폼이 먼저 끊어 안내도 기록도 못 남긴다. 문서 읽기 라우트와 같은 300초
export const maxDuration = 300;

function jsonError(message: string, status: number) {
  return NextResponse.json({ ok: false, error: { message } }, { status });
}

/**
 * ③ 올린 첨부 확인·읽기. 읽지 못한 파일도 200 + status 'failed'로 돌려준다 —
 * 화면 칩에 이유를 보이기 위해서다. 권한·시간·크기 실패만 4xx.
 */
export async function POST(request: NextRequest) {
  const session = await getServerAuthSession();
  if (!session?.user?.id) return jsonError('인증이 필요합니다.', 401);

  const actor = await getActorScope(session);
  if (!actor?.organizationId) return jsonError('소속 기관을 확인할 수 없습니다.', 403);

  let body: { id?: unknown };
  try {
    body = await request.json();
  } catch {
    return jsonError('요청 형식이 올바르지 않습니다.', 400);
  }

  const result = await confirmUpload(
    { userId: actor.userId, departmentId: actor.departmentId, organizationId: actor.organizationId },
    typeof body.id === 'string' ? body.id : ''
  );
  if (!result.ok) return jsonError(result.message, result.status);
  return NextResponse.json({ ok: true, data: result.attachment });
}

/** 이 대화에서 내가 붙인 읽힌 첨부. 남의 대화 id면 404 */
export async function GET(request: NextRequest) {
  const session = await getServerAuthSession();
  if (!session?.user?.id) return jsonError('인증이 필요합니다.', 401);

  const conversationId = request.nextUrl.searchParams.get('conversation_id') ?? '';
  if (!(await isConversationOwner(session.user.id, conversationId))) {
    return jsonError('대화를 찾을 수 없습니다.', 404);
  }

  // 저장소 경로는 화면에 보내지 않는다
  const rows = (await listConversationAttachments(session.user.id, conversationId)).map(toClientRow);
  return NextResponse.json({ ok: true, data: rows });
}
