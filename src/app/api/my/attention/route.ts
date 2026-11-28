import { NextResponse } from 'next/server';
import { getServerAuthSession } from '@/lib/auth';
import { actorScopeOr503 } from '@/lib/actor-scope-response';
import { loadMyAttention } from '@/lib/my-attention';
import { ATTENTION_UNREAD } from '@/lib/my-attention-spec';

export const dynamic = 'force-dynamic';

/** 확인할 일(2026-11-28, `src/lib/my-attention.ts`) — 세션 본인의 것만. 못 읽으면 503('없음'으로 보이지 않게) */
export async function GET() {
  const session = await getServerAuthSession();
  if (!session?.user?.id) return NextResponse.json({ ok: false, error: { message: '인증이 필요합니다.' } }, { status: 401 });
  const actor = await actorScopeOr503(session);
  if (actor instanceof Response) return actor;
  if (!actor) return NextResponse.json({ ok: true, data: [] });
  try {
    return NextResponse.json({ ok: true, data: await loadMyAttention(actor) });
  } catch (err) {
    console.error('확인할 일 읽기 오류:', (err as { code?: string })?.code ?? 'unknown');
    return NextResponse.json({ ok: false, error: { message: ATTENTION_UNREAD } }, { status: 503 });
  }
}
