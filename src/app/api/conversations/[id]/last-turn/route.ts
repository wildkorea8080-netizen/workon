import { NextRequest, NextResponse } from 'next/server';
import { getServerAuthSession } from '@/lib/auth';
import { supabaseAdmin } from '@/lib/supabaseAdmin';
import { decideLastTurn, type TurnRow } from '@/lib/last-turn';

export const dynamic = 'force-dynamic';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const READ_FAILED = '대화를 지금 읽지 못했습니다. 잠시 뒤 다시 시도해 주세요.';

function jsonError(message: string, status: number) {
  return NextResponse.json({ ok: false, error: { message } }, { status });
}

/**
 * 마지막 질문·답 지우기(2026-11-28, `src/lib/last-turn.ts`) — '답변 다시 받기'·'질문 고쳐 묻기'가 다시 묻기 전에 부른다.
 * `?message=` = 화면이 보는 마지막 답의 id. 대화 주인만(남의·없는 대화 404), 못 읽으면 503
 */
export async function DELETE(request: NextRequest, { params }: { params: { id: string } }) {
  const session = await getServerAuthSession();
  if (!session?.user?.id) return jsonError('인증이 필요합니다.', 401);
  const messageId = request.nextUrl.searchParams.get('message') ?? '';
  if (!UUID.test(messageId)) return jsonError('지울 답변을 확인할 수 없습니다.', 400);

  const { data: conversation, error: convError } = await supabaseAdmin
    .from('conversations')
    .select('id')
    .eq('id', params.id)
    .eq('user_id', session.user.id)
    .maybeSingle();
  if (convError) return jsonError(READ_FAILED, 503);
  if (!conversation) return jsonError('대화를 찾을 수 없습니다.', 404);

  // 최신순 — 한 턴의 질문·답은 같은 시각이라 같으면 답(assistant)이 먼저(2026-11-18 규칙)
  const { data: latest, error: readError } = await supabaseAdmin
    .from('messages')
    .select('id, role, source_references')
    .eq('conversation_id', params.id)
    .order('created_at', { ascending: false })
    .order('role', { ascending: true })
    .limit(2);
  if (readError) return jsonError(READ_FAILED, 503);

  const verdict = decideLastTurn((latest ?? []) as TurnRow[], messageId);
  if (!verdict.ok) return jsonError(verdict.message, verdict.status);

  const { data: removed, error: deleteError } = await supabaseAdmin
    .from('messages')
    .delete()
    .in('id', verdict.ids)
    .eq('conversation_id', params.id)
    .select('id');
  if (deleteError) return jsonError('답변을 지우지 못했습니다. 잠시 뒤 다시 시도해 주세요.', 503);
  return NextResponse.json({ ok: true, data: { removed: (removed ?? []).length } });
}
