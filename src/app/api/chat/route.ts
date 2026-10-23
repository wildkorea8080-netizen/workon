import { NextRequest, NextResponse } from 'next/server';
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
    if (!prepared.ok) {
      // 능력 preflight 거절(참고 문서를 불러오지 못함 등)은 화면이 버튼을 고르도록 error.code에 싣는다.
      // 다른 거절은 지금 모양({ message, details }) 그대로
      const code = prepared.details?.code;
      if (typeof code === 'string') {
        return NextResponse.json({ ok: false, error: { message: prepared.message, code } }, { status: prepared.status });
      }
      return jsonError(prepared.message, prepared.status, prepared.details);
    }

    const encoder = new TextEncoder();
    const stream = new ReadableStream<Uint8Array>({
      async start(controller) {
        try {
          // 연결이 끊기면 enqueue가 던진다. 삼켜야 저장·사용 기록까지 끝까지 간다.
          const send = (event: TurnEvent) => {
            try {
              controller.enqueue(encoder.encode(sse(event)));
            } catch {
              // 클라이언트가 떠났다
            }
          };
          await streamTurn(prepared.turn, send);
        } catch (error) {
          console.error('[chat] stream error:', error);
          try {
            controller.enqueue(encoder.encode(sse({ event: 'error', data: { message: '응답 생성 중 오류가 발생했습니다.' } })));
          } catch {
            // 클라이언트가 떠났다
          }
        } finally {
          try {
            controller.close();
          } catch {
            // 이미 닫혔다
          }
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
