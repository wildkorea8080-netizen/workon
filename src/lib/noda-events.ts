// src/lib/noda-events.ts
import { supabaseAdmin } from '@/lib/supabaseAdmin';
import { logSystem } from '@/lib/logger';
import { noda, nodaErrorFields, type NodaClient } from '@/lib/noda';
import { applyNodaEvent } from '@/lib/noda-webhook';

/**
 * 놓친 웹훅 다시 받기 (2026-10-26, NODA `GET /events`).
 *
 * 웹훅은 알림이지 장부가 아니다 — NODA가 다시 뜨거나 우리 쪽이 잠깐 못 받으면 그 사이 알림은 사라진다.
 * NODA는 같은 일을 장부에 적어 두므로, 마지막으로 처리한 자리(`next`) 뒤의 일을 가져와 웹훅과 **같은 처리**(`applyNodaEvent`)를 한다.
 * 처리는 `reading` 행만 바꾸는 조건부 갱신이라 웹훅이 이미 처리한 일이 다시 와도 해가 없다(같은 일을 따로 거르지 않는다).
 *
 * - 자리는 `system_settings`의 `noda_events_cursor`(값 = 마지막으로 처리한 일의 id)에 둔다
 * - **1분에 한 번만** 돈다 — 그 행의 `updated_at`을 조건부로 바꿔 차지한 쪽만 부른다(두 요청이 겹쳐도 한 번)
 * - 부르는 곳: 문서 목록(`GET /api/documents`)·공통 자료실 목록(`GET /api/super/common-documents`)·하루 한 번 예약 작업(`/api/cron/noda-events`).
 *   Vercel은 응답 뒤 일을 이어 가지 못하므로 목록을 여는 김에 짧게(전체 `REPLAY_BUDGET_MS`) 돈다
 * - 일 하나를 처리하다 던지면(DB 오류) 거기서 멈추고 **그 앞까지만** 자리를 옮긴다 — 다음에 그 일부터 다시
 * - `gap: true`(장부가 그 자리까지 못 거슬러 감)는 운영 기록에 남기고 이어 간다 — 빠진 일은 문서 목록 맞추기가 메운다
 * - 장부를 처음 읽을 때(자리 없음)는 가장 새 일들부터 받는다(이미 끝난 일은 처리해도 바뀌는 것이 없다)
 */

export const EVENTS_CURSOR_KEY = 'noda_events_cursor';
/** 두 번 사이 최소 간격 */
export const REPLAY_MIN_INTERVAL_MS = 60_000;
/** 한 번에 쓰는 전체 시간 — 목록 응답이 늦어지지 않게 */
export const REPLAY_BUDGET_MS = 3_000;
/** 장부 한 번 부르기의 시간 제한(다시 시도 없음) */
export const REPLAY_LIST_TIMEOUT_MS = 2_500;
export const REPLAY_PAGE_LIMIT = 100;
export const REPLAY_MAX_PAGES = 5;
/** 남은 예산이 이보다 적으면 장부를 더 부르지 않는다 */
const MIN_LIST_TIMEOUT_MS = 500;

export interface EventsCursorStore {
  /** 1분 차지 — 차지했으면 지금 자리(없으면 null), 못 했으면(다른 요청이 1분 안에 돌았음) undefined */
  claim(nowIso: string, cutoffIso: string): Promise<{ cursor: string | null } | undefined>;
  save(cursor: string, nowIso: string): Promise<void>;
}

export interface ReplayDeps {
  store: EventsCursorStore;
  noda: Pick<NodaClient, 'listEvents'>;
  apply: (event: Record<string, unknown>) => Promise<unknown>;
  now: () => number;
  log: (p: Parameters<typeof logSystem>[0]) => Promise<void>;
}

export interface ReplayResult {
  status: 'skipped' | 'done' | 'partial' | 'failed';
  processed: number;
  gap: boolean;
}

function defaultStore(): EventsCursorStore {
  return {
    async claim(nowIso, cutoffIso) {
      const { data, error } = await supabaseAdmin
        .from('system_settings')
        .update({ updated_at: nowIso })
        .eq('key', EVENTS_CURSOR_KEY)
        .lt('updated_at', cutoffIso)
        .select('value');
      if (error) throw new Error(`NODA 일 장부 자리 차지 실패: ${error.message}`);
      if (data && data.length > 0) {
        const v = (data[0] as { value: string }).value;
        return { cursor: v || null };
      }
      // 행이 없으면(처음) 만든다 — 겹친 요청은 하나만 만들어진다(나머지는 아무것도 못 넣어 빈 결과)
      const { data: created, error: insertError } = await supabaseAdmin
        .from('system_settings')
        .upsert(
          { key: EVENTS_CURSOR_KEY, value: '', description: 'NODA 일 장부(놓친 웹훅) 마지막으로 처리한 자리 — 자동으로 바뀐다', updated_at: nowIso },
          { onConflict: 'key', ignoreDuplicates: true },
        )
        .select('value');
      if (insertError) throw new Error(`NODA 일 장부 자리 만들기 실패: ${insertError.message}`);
      return created && created.length > 0 ? { cursor: null } : undefined;
    },
    async save(cursor, nowIso) {
      const { error } = await supabaseAdmin
        .from('system_settings')
        .update({ value: cursor, updated_at: nowIso })
        .eq('key', EVENTS_CURSOR_KEY);
      if (error) throw new Error(`NODA 일 장부 자리 저장 실패: ${error.message}`);
    },
  };
}

export function defaultReplayDeps(): ReplayDeps {
  return { store: defaultStore(), noda, apply: (e) => applyNodaEvent(e), now: () => Date.now(), log: logSystem };
}

/** 던지지 않는다 — 실패는 운영 기록에 남기고 다음 기회에 이어 간다 */
export async function replayNodaEvents(deps: ReplayDeps = defaultReplayDeps()): Promise<ReplayResult> {
  const begin = deps.now();
  let claimed: { cursor: string | null } | undefined;
  try {
    claimed = await deps.store.claim(new Date(begin).toISOString(), new Date(begin - REPLAY_MIN_INTERVAL_MS).toISOString());
  } catch (err) {
    await deps.log({
      level: 'warning',
      category: 'database',
      message: 'NODA 놓친 알림 다시 받기 — 자리를 차지하지 못함',
      details: { error: err instanceof Error ? err.message : String(err) },
    });
    return { status: 'failed', processed: 0, gap: false };
  }
  if (!claimed) return { status: 'skipped', processed: 0, gap: false };

  let cursor = claimed.cursor;
  let processed = 0;
  let gap = false;
  const saveCursor = async (id: string) => {
    if (id === cursor) return;
    await deps.store.save(id, new Date(deps.now()).toISOString());
    cursor = id;
  };

  try {
    for (let page = 0; page < REPLAY_MAX_PAGES; page++) {
      const remaining = REPLAY_BUDGET_MS - (deps.now() - begin);
      if (remaining < MIN_LIST_TIMEOUT_MS) return { status: 'partial', processed, gap };

      let result;
      try {
        result = await deps.noda.listEvents({
          since: cursor,
          limit: REPLAY_PAGE_LIMIT,
          timeoutMs: Math.min(REPLAY_LIST_TIMEOUT_MS, remaining),
        });
      } catch (err) {
        await deps.log({
          level: 'warning',
          category: 'api',
          message: 'NODA 놓친 알림 다시 받기 — 일 장부를 읽지 못함',
          details: { ...nodaErrorFields(err), processed },
        });
        return { status: processed > 0 ? 'partial' : 'failed', processed, gap };
      }

      if (result.gap && !gap) {
        gap = true;
        await deps.log({
          level: 'warning',
          category: 'api',
          message: 'NODA 일 장부가 마지막 자리까지 거슬러 가지 못함 — 그 사이 알림은 문서 목록 맞추기가 메운다',
          details: { since: cursor },
        });
      }

      for (const event of result.events) {
        try {
          await deps.apply(event);
        } catch (err) {
          // 이 일부터 다음에 다시 — 앞까지만 자리를 옮긴다(파일 이름은 남기지 않는다)
          await deps.log({
            level: 'warning',
            category: 'database',
            message: 'NODA 놓친 알림을 처리하지 못해 멈춤 — 다음에 이어서',
            details: { event_id: event.id, event: typeof event.event === 'string' ? event.event : null, error: err instanceof Error ? err.message : String(err) },
          });
          return { status: 'partial', processed, gap };
        }
        processed += 1;
        await saveCursor(event.id);
      }
      if (result.next) await saveCursor(result.next);
      if (!result.more) return { status: 'done', processed, gap };
    }
    return { status: 'partial', processed, gap };
  } catch (err) {
    // 자리 저장 실패 — 다음에 같은 일을 다시 받는다(처리는 겹쳐도 해가 없다)
    await deps.log({
      level: 'warning',
      category: 'database',
      message: 'NODA 놓친 알림 다시 받기 — 자리를 저장하지 못함',
      details: { error: err instanceof Error ? err.message : String(err), processed },
    });
    return { status: 'partial', processed, gap };
  }
}
