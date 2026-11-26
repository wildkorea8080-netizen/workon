// src/lib/apps/batch-lanes.ts
// 일괄 실행 전용 실행기 더 띄우기(2026-11-26). 5분 실행기(`/api/cron/app-schedules`) 하나는 한 차례에 줄 몇 개만 시작한다(시작 창 90초 × 3줄씩) —
// 500줄(0123)은 몇 시간이 걸린다. 기다리는 줄이 많으면 5분 실행기가 `/api/cron/app-batches?lane=N`을 몇 번 더 불러(각각 따로 도는 함수)
// 나란히 줄을 집게 한다. 줄 차지는 조건부라 같은 줄을 두 번 돌리지 않는다. 자격은 5분 실행기가 받은 Bearer 그대로(같은 비밀값).
// 부르는 주소는 서버 설정(`APP_URL`)뿐이다 — 요청 머리글(Host)로 정하지 않는다(비밀값을 다른 곳으로 보내지 않게).
import { supabaseAdmin } from '@/lib/supabaseAdmin';
import { BATCH_EXTRA_LANES_MAX } from './batches';

/** 더 띄운 실행기를 기다리는 시간 — 5분 실행기의 함수 시간 제한(300초) 안 */
export const BATCH_LANE_WAIT_MS = 280_000;

/** 실행 중인 묶음의 기다리는 줄 수(대략 — 끝난 묶음의 대기 줄은 건너뜀으로 바뀐다). 못 세면 0(더 띄우지 않음) */
export async function pendingBatchRows(): Promise<number> {
  const { count, error } = await supabaseAdmin.from('app_batch_items').select('id', { count: 'exact', head: true }).eq('status', 'pending');
  if (error) return 0;
  return count ?? 0;
}

export type LaneDispatch = { requested: number; started: number; failed: number };

/** 주소가 http(s)일 때만 — 끝의 `/`는 뗀다. 아니면 null(띄우지 않음) */
export function laneBaseUrl(raw: string | undefined | null): string | null {
  if (!raw) return null;
  try {
    const url = new URL(raw);
    if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;
    return url.origin;
  } catch { return null; }
}

/**
 * 실행기 `lanes`개를 더 띄우고 끝날 때까지(많아야 `BATCH_LANE_WAIT_MS`) 기다린다. 던지지 않는다 — 못 띄우면 수만 센다
 * (5분 실행기 자신의 몫은 그대로 돌고, 남은 줄은 다음 차례에).
 */
export async function dispatchBatchLanes(a: {
  baseUrl: string | null; authorization: string; lanes: number;
  fetchImpl?: typeof fetch; waitMs?: number;
}): Promise<LaneDispatch> {
  const lanes = Math.max(0, Math.min(BATCH_EXTRA_LANES_MAX, Math.floor(a.lanes)));
  if (!lanes || !a.baseUrl || !a.authorization) return { requested: lanes, started: 0, failed: 0 };
  const call = a.fetchImpl ?? fetch;
  const out: LaneDispatch = { requested: lanes, started: 0, failed: 0 };
  await Promise.all(Array.from({ length: lanes }, async (_, i) => {
    try {
      const res = await call(`${a.baseUrl}/api/cron/app-batches?lane=${i + 1}`, {
        method: 'POST', headers: { authorization: a.authorization }, cache: 'no-store', redirect: 'manual',
        signal: AbortSignal.timeout(a.waitMs ?? BATCH_LANE_WAIT_MS),
      });
      if (res.ok) out.started++; else out.failed++;
    } catch {
      // 기다리다 끊긴 것(시간 초과)도 여기 — 그 실행기는 제 함수 안에서 끝까지 돈다. 집은 줄이 끊겼으면 15분 뒤 다시 집힌다
      out.failed++;
    }
  }));
  return out;
}
