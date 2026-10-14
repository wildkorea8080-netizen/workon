import { NextRequest } from 'next/server';
import { getServerAuthSession } from '@/lib/auth';
import { jsonError } from '@/lib/agent-route-helpers';
import { prepareTurn } from '@/lib/assistant/prepare';
import { streamTurn } from '@/lib/assistant/stream';
import type { TurnEvent } from '@/lib/assistant/types';

/**
 * 대화 한 턴. 일은 실행기(src/lib/assistant/)가 한다.
 * 여기서는 인증 → 준비(거절이면 JSON) → SSE로 흘려보내기만 한다.
 */
function sse(event: TurnEvent): string {
  return `event: ${event.event}\ndata: ${JSON.stringify(event.data)}\n\n`;
}

export async function POST(request: NextRequest) {
  try {
    const session = await getServerAuthSession();
    if (!session?.user?.id) return jsonError('인증이 필요합니다.', 401);

    const body = (await request.json()) as Record<string, unknown>;
    const prepared = await prepareTurn(session, body);
    if (!prepared.ok) return jsonError(prepared.message, prepared.status, prepared.details);

    const encoder = new TextEncoder();
    const stream = new ReadableStream<Uint8Array>({
      async start(controller) {
        try {
          await streamTurn(prepared.turn, (event) => controller.enqueue(encoder.encode(sse(event))));
        } catch (error) {
          console.error('[chat] stream error:', error);
          controller.enqueue(encoder.encode(sse({ event: 'error', data: { message: '응답 생성 중 오류가 발생했습니다.' } })));
        } finally {
          controller.close();
        }
      },
    });

    return new Response(stream, {
      headers: {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-cache, no-transform',
        Connection: 'keep-alive',
        // Vercel/nginx 프록시가 스트림을 버퍼링하지 않도록
        'X-Accel-Buffering': 'no',
      },
    });
  } catch (error) {
    console.error('채팅 오류:', error);
    return jsonError(error instanceof Error ? error.message : '서버 오류가 발생했습니다.', 500);
  }
}
