import { NextResponse, type NextRequest } from 'next/server';
import { getServerAuthSession, isAdminSession } from '@/lib/auth';
import { actorScopeOr503 } from '@/lib/actor-scope-response';
import { supabaseAdmin } from '@/lib/supabaseAdmin';
import { readJsonObject, BAD_BODY_MESSAGE } from '@/lib/request-body';
import { askPublic } from '@/lib/public-ask/service';
import { publicAskDeps } from '@/lib/public-ask/deps';
import { PUBLIC_ASK_MESSAGES } from '@/lib/public-ask/spec';

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

function jsonError(message: string, status: number, code?: string) {
  return NextResponse.json({ ok: false, error: { message, ...(code ? { code } : {}) } }, { status });
}

/**
 * 시민 상담 미리 물어보기(2026-11-28) — 창을 열기 전에 기관 전체 관리자가 시민 화면과 같은 엔진으로 답을 본다.
 * 켜짐 여부·하루 횟수를 보지 않고 시민 기록에 남기지 않는다(모델을 부르므로 사용 기록 `public_ask`는 남는다). SSE는 시민 길과 같다
 */
export async function POST(request: NextRequest) {
  const session = await getServerAuthSession();
  if (!session?.user?.id || !isAdminSession(session)) return jsonError('관리자 권한이 필요합니다.', 403);
  const actor = await actorScopeOr503(session);
  if (actor instanceof Response) return actor;
  if (!actor?.organizationId) return jsonError('소속 기관을 확인할 수 없습니다.', 403);
  if (!actor.managesWholeOrganization) return jsonError('시민 상담 창은 기관 전체 관리자(최상위 부서 소속)만 다룹니다.', 403);
  const body = await readJsonObject(request);
  if (!body) return jsonError(BAD_BODY_MESSAGE, 400);

  const { data: org, error } = await supabaseAdmin.from('organizations').select('slug').eq('id', actor.organizationId).maybeSingle();
  if (error) return jsonError(PUBLIC_ASK_MESSAGES.unavailable, 503);
  const slug = (org as { slug?: string | null } | null)?.slug;
  if (!slug) return jsonError('기관 로그인 경로(주소)가 없어 미리 물어볼 수 없습니다.', 400);

  let result: Awaited<ReturnType<typeof askPublic>>;
  try {
    result = await askPublic({ slug, question: body.question, previousQuestion: body.previousQuestion, ip: null, preview: true }, publicAskDeps());
  } catch {
    return jsonError(PUBLIC_ASK_MESSAGES.unavailable, 503, 'unavailable');
  }
  if (!result.ok) return jsonError(result.message, result.status, result.code);
  const events = result.events;
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      try {
        for await (const ev of events) controller.enqueue(encoder.encode(`data: ${JSON.stringify(ev)}\n\n`));
      } catch {
        controller.enqueue(encoder.encode(`data: ${JSON.stringify({ type: 'error', message: PUBLIC_ASK_MESSAGES.unavailable })}\n\n`));
      } finally {
        controller.close();
      }
    },
  });
  return new Response(stream, { headers: { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-cache, no-transform' } });
}
