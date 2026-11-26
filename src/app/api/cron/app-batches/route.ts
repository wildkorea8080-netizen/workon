import { NextResponse } from 'next/server';
import { workerSecretRejection } from '@/lib/cron-auth';
import { BATCH_EXTRA_LANES_MAX, batchDeps, runDueBatchItems } from '@/lib/apps/batches';

export const dynamic = 'force-dynamic';
// 줄 실행 하나가 2분 남짓 — 시작 창(90초) + 마감(150초)보다 길게
export const maxDuration = 300;

/**
 * 일괄 실행 전용 실행기(2026-11-26, `src/lib/apps/batch-lanes.ts`). 기다리는 줄이 많을 때 5분 실행기(`/api/cron/app-schedules`)가 받은 Bearer 그대로
 * `?lane=1~3`으로 몇 번 더 부른다 — 따로 도는 함수마다 줄을 나란히 집는다(차지는 조건부라 같은 줄을 두 번 돌리지 않음).
 * 자격은 앱 예약 실행기와 같다(`WORK_WORKER_SECRET` 또는 `CRON_SECRET` Bearer, 상수 시간 비교, 둘 다 없으면 503).
 * 하는 일은 DB에 이미 있는 차례가 된 일괄 실행 줄을 조건부로 차지해 만든 직원의 권한으로 돌리는 것뿐 — `lane`은 살펴볼 순서만 돌린다(대상을 고르지 않음)
 */
export async function POST(request: Request) {
  const rejected = workerSecretRejection(request);
  if (rejected) return rejected;
  const raw = Number(new URL(request.url).searchParams.get('lane'));
  const lane = Number.isInteger(raw) && raw >= 1 && raw <= BATCH_EXTRA_LANES_MAX ? raw : 1;
  const batches = await runDueBatchItems(batchDeps(), { lane });
  return NextResponse.json({ ok: true, data: { lane, batches } });
}

export async function GET(request: Request) {
  return POST(request);
}
