import { NextRequest, NextResponse } from 'next/server';
import { getServerAuthSession } from '@/lib/auth';
import { BAD_BODY_MESSAGE, readJsonObject } from '@/lib/request-body';
import { requestStop } from '@/lib/assistant/stop';

export const dynamic = 'force-dynamic';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function jsonError(message: string, status: number) {
  return NextResponse.json({ ok: false, error: { message } }, { status });
}

/**
 * 답변 멈추기(2026-11-28, 0137, `src/lib/assistant/stop.ts`) — 몸 `{ message_id }` = 화면이 받고 있는 답의 id(`meta`로 받음).
 * 대화 주인만(남의·없는 대화 404). 멈춤은 답을 만드는 함수가 1초 남짓 뒤에 알아채고, 받은 데까지 저장한 뒤 `done`(stopped)으로 끝낸다
 */
export async function POST(request: NextRequest, { params }: { params: { id: string } }) {
  const session = await getServerAuthSession();
  if (!session?.user?.id) return jsonError('인증이 필요합니다.', 401);
  const body = await readJsonObject(request);
  if (!body) return jsonError(BAD_BODY_MESSAGE, 400);
  const messageId = typeof body.message_id === 'string' ? body.message_id : '';
  if (!UUID.test(messageId)) return jsonError('멈출 답변을 확인할 수 없습니다.', 400);
  try {
    const result = await requestStop({ conversationId: params.id, userId: session.user.id, messageId });
    if (result === 'not_found') return jsonError('대화를 찾을 수 없습니다.', 404);
    return NextResponse.json({ ok: true });
  } catch (error) {
    console.error('[conversations/stop] 멈춤 요청 실패:', (error as { code?: unknown })?.code ?? 'error');
    return jsonError('지금 답변을 멈추지 못했습니다. 잠시 뒤 다시 눌러 주세요.', 503);
  }
}
