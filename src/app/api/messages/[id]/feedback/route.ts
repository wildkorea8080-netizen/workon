import { NextRequest, NextResponse } from 'next/server';
import { getServerAuthSession } from '@/lib/auth';
import { getActorScope } from '@/lib/actor-scope';
import { saveMessageFeedback } from '@/lib/message-feedback';
import { parseFeedback } from '@/lib/message-feedback-spec';

export const dynamic = 'force-dynamic';

function jsonError(message: string, status: number) {
  return NextResponse.json({ ok: false, error: { message } }, { status });
}

/**
 * 답변 평가(0064) — `{ rating: 'up' | 'down' | null, reason? }`. 대화 주인만, 답변 메시지만. null이면 지운다.
 * 이유는 정해 둔 코드만(자유 글 없음)
 */
export async function PUT(request: NextRequest, { params }: { params: { id: string } }) {
  const session = await getServerAuthSession();
  if (!session?.user?.id) return jsonError('인증이 필요합니다.', 401);
  const actor = await getActorScope(session);
  if (!actor?.organizationId) return jsonError('소속 기관을 확인할 수 없습니다.', 403);
  const input = parseFeedback(await request.json().catch(() => null));
  if (!input) return jsonError('평가 값을 확인해 주세요.', 400);
  const result = await saveMessageFeedback({ userId: actor.userId, organizationId: actor.organizationId }, params.id, input);
  if (!result.ok) return jsonError(result.message, result.status);
  return NextResponse.json({ ok: true, data: result.feedback });
}
