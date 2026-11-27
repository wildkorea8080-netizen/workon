import { NextResponse, type NextRequest } from 'next/server';
import { requestIp } from '@/lib/sign-in-throttle';
import { readJsonObject, BAD_BODY_MESSAGE } from '@/lib/request-body';
import { askPublic, loadPublicConfig } from '@/lib/public-ask/service';
import { publicAskDeps } from '@/lib/public-ask/deps';
import { PUBLIC_ASK_MESSAGES } from '@/lib/public-ask/spec';
import { logSystem } from '@/lib/logger';

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

function jsonError(message: string, status: number, code?: string) {
  return NextResponse.json({ ok: false, error: { message, ...(code ? { code } : {}) } }, { status });
}

/**
 * 시민용 민원 상담 창(2026-11-27, 0136) — **로그인 없이 열린다**(시민이 쓴다). 자격 대신 기관 설정(기관 전체 관리자가 켬)·
 * 하루 횟수(IP·기관)·기관 예산·개인정보 필터가 막는다. 응답에 비서·문서 id·근거 원문은 싣지 않는다.
 * GET = 공개 설정(기관 이름·로고·테마 색·안내·자주 묻는 질문·연락처), POST `{ question, previousQuestion? }` = SSE(`delta`·`done`·`error`)
 */
export async function GET(_request: NextRequest, { params }: { params: { slug: string } }) {
  try {
    const r = await loadPublicConfig(params.slug, publicAskDeps());
    if (!r.ok) return jsonError(r.message, r.status, r.code);
    return NextResponse.json({ ok: true, data: r.config });
  } catch {
    return jsonError(PUBLIC_ASK_MESSAGES.unavailable, 503, 'unavailable');
  }
}

export async function POST(request: NextRequest, { params }: { params: { slug: string } }) {
  const body = await readJsonObject(request);
  if (!body) return jsonError(BAD_BODY_MESSAGE, 400);
  let result: Awaited<ReturnType<typeof askPublic>>;
  try {
    result = await askPublic({ slug: params.slug, question: body.question, previousQuestion: body.previousQuestion, ip: requestIp(request.headers) }, publicAskDeps());
  } catch (err) {
    await logSystem({ level: 'warning', category: 'api', message: '시민 상담 질문을 처리하지 못했습니다', details: { code: (err as { code?: string })?.code ?? 'error' } });
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
