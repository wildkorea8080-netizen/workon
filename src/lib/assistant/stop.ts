// src/lib/assistant/stop.ts
// 답변 멈추기(2026-11-28, 0137) — 직원이 길게 흐르는 답을 도중에 멈춘다.
// 연결이 끊겨도 답은 끝까지 만들어 저장한다(새로고침해도 대화가 남게 — 라우트·실행기의 약속)는 것을 지키려고,
// 멈춤은 연결 끊기가 아니라 따로 보낸 요청으로 한다: 화면이 `POST /api/conversations/[id]/stop { message_id }`로
// 대화 행에 멈출 답 id를 적고, 답을 만드는 함수가 짧은 간격으로 그 칸을 읽어 이 턴의 답 id면 받기를 그만둔다.
// (Vercel 함수는 서로 다른 곳에서 돌아 기억을 함께 쓰지 못한다 — DB 칸 하나가 둘을 잇는다)
import { supabaseAdmin } from '@/lib/supabaseAdmin';
import { logSystem } from '@/lib/logger';
export { STOPPED_EMPTY_TEXT } from './stop-spec';

/** 멈춤 요청을 읽는 간격 — 누른 뒤 1초 남짓에 멈춘다 */
export const STOP_POLL_MS = 1200;
/** 읽기를 그만두는 때 — 대화 라우트의 함수 시간 제한(300초)과 같다. 끝을 알리지 못하고 끝나도 돌지 않게 */
export const STOP_WATCH_LIFETIME_MS = 300_000;

export async function readStopRequest(conversationId: string, db = supabaseAdmin): Promise<string | null> {
  const { data, error } = await db.from('conversations').select('stop_message_id').eq('id', conversationId).maybeSingle();
  if (error) throw error;
  const id = (data as { stop_message_id?: unknown } | null)?.stop_message_id;
  return typeof id === 'string' ? id : null;
}

/** 대화 주인만 — 다른 사람의 대화·없는 대화는 'not_found'. 못 쓰면 던진다 */
export async function requestStop(input: { conversationId: string; userId: string; messageId: string }, db = supabaseAdmin): Promise<'ok' | 'not_found'> {
  const { data, error } = await db.from('conversations')
    .update({ stop_message_id: input.messageId })
    .eq('id', input.conversationId).eq('user_id', input.userId)
    .select('id');
  if (error) throw error;
  return Array.isArray(data) && data.length > 0 ? 'ok' : 'not_found';
}

/**
 * 이 턴의 답 id가 멈춤 요청으로 적히면 신호를 건다. 읽기는 하나씩(앞 읽기가 끝나기 전에 다음을 보내지 않음),
 * 못 읽으면 다음 차례에 다시 — 멈추지 못할 뿐 답은 그대로 간다(못 읽은 것은 한 번만 운영 기록에)
 */
export function watchStop(opts: {
  conversationId: string;
  messageId: string;
  read: (conversationId: string) => Promise<string | null>;
  everyMs: number;
  orgId?: string | null;
  lifetimeMs?: number;
  now?: () => number;
}): { signal: AbortSignal; end: () => void } {
  const controller = new AbortController();
  const now = opts.now ?? Date.now;
  const startedAt = now();
  let busy = false;
  let ended = false;
  let warned = false;
  let timer: ReturnType<typeof setInterval> | null = null;
  const end = () => {
    ended = true;
    if (timer) clearInterval(timer);
    timer = null;
  };
  timer = setInterval(async () => {
    if (busy || ended) return;
    if (now() - startedAt > (opts.lifetimeMs ?? STOP_WATCH_LIFETIME_MS)) { end(); return; }
    busy = true;
    try {
      if ((await opts.read(opts.conversationId)) === opts.messageId && !ended) {
        controller.abort();
        end();
      }
    } catch (error) {
      if (!warned) {
        warned = true;
        await logSystem({
          level: 'warning', category: 'database', message: '답변 멈춤 요청을 읽지 못했습니다(이 답은 멈추지 못함)',
          details: { code: (error as { code?: unknown })?.code ?? null }, orgId: opts.orgId ?? null,
        }).catch(() => undefined);
      }
    } finally {
      busy = false;
    }
  }, opts.everyMs);
  // 함수가 끝나기를 이 시계가 붙잡지 않게
  (timer as { unref?: () => void }).unref?.();
  return { signal: controller.signal, end };
}
