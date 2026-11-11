import { NextResponse } from 'next/server';
import { timingSafeEqual } from 'crypto';
import { CRON_SECRET, WORK_WORKER_SECRET } from '@/lib/config';
import { runDueSchedules, scheduleDeps } from '@/lib/apps/schedules';
import { recordRunnerHeartbeat } from '@/lib/apps/schedule-health';
import { dispatchDueDeliveries, outboundDeps } from '@/lib/apps/outbound/deliver';
import { batchDeps, runDueBatchItems } from '@/lib/apps/batches';
import { runOutboundNotices } from '@/lib/apps/outbound/notices';
import { autoIndexReferences } from '@/lib/document-references';
import { autoIndexDeps } from '@/lib/document-references-db';

export const dynamic = 'force-dynamic';
// 실행 하나가 단계 3개 + 최종 답까지 수 분 걸릴 수 있다 — 실행기의 시간 예산(180초)보다 길게
export const maxDuration = 300;

/** Bearer 비밀값이 이 값과 같은가(상수 시간 비교). 값이 비었으면 거짓 */
function matches(header: string, secret: string | undefined): boolean {
  if (!secret) return false;
  const given = Buffer.from(header);
  const expected = Buffer.from(`Bearer ${secret}`);
  return given.length === expected.length && timingSafeEqual(given, expected);
}

/**
 * 입력형 앱 예약 실행기(`src/lib/apps/schedules.ts`). Supabase pg_cron이 5분마다 부른다(Vercel Hobby 예약 작업은 하루 한 번·2개까지라 쓰지 않는다 — APP_SCHEDULES.md).
 * 자격은 Bearer 비밀값 하나 — **업무 작업자와 같은 `WORK_WORKER_SECRET`**(pg_cron이 Vault `work_worker_secret`으로 이미 싣는 값) 또는 `CRON_SECRET`.
 * 둘 다 서버 예약 작업용 비밀값이고 상수 시간으로 비교한다. 하는 일은 DB에 이미 있는 차례가 된 예약을 조건부로 차지해 그 직원의 권한으로 실행하는 것뿐이다
 * (요청값으로 대상을 고르지 않는다). 두 비밀값이 모두 없으면 503
 */
export async function GET(request: Request) {
  if (!WORK_WORKER_SECRET && !CRON_SECRET) {
    return NextResponse.json({ ok: false, error: { message: '예약 작업이 설정되지 않았습니다.' } }, { status: 503 });
  }
  const header = request.headers.get('authorization') ?? '';
  if (!matches(header, WORK_WORKER_SECRET) && !matches(header, CRON_SECRET)) {
    return NextResponse.json({ ok: false, error: { message: '인증이 필요합니다.' } }, { status: 401 });
  }
  // '살아 있음' 도장 — 하루 한 번 Vercel 예약 작업이 이 도장으로 pg_cron이 멈췄는지 본다(schedule-health.ts). 실패해도 실행은 이어 간다
  await recordRunnerHeartbeat(Date.now());
  // 앱 결과 보내기(0076)·일괄 실행(0077) — 예약 실행과 나란히(예약의 시간 예산을 쓰지 않게). 던지지 않는다
  // 보내기 알림(2026-11-10, 0081) — 그만둔 보내기는 기관 전체 관리자에게(보낼 곳마다 6시간에 한 번), 확인 기다림은 실행한 직원에게(결과마다 한 번)
  // 문서 참조 색인 자동 채우기(2026-11-12) — 색인 없는 문서 두 개씩(원본 읽기만, 모델 없음). 던지지 않는다
  const [outbound, batches, result, notices, references] = await Promise.all([
    dispatchDueDeliveries(outboundDeps(), { limit: 20, budgetMs: 60_000 }),
    runDueBatchItems(batchDeps()),
    runDueSchedules(scheduleDeps()),
    runOutboundNotices().catch(() => null),
    autoIndexReferences(autoIndexDeps()).catch(() => null),
  ]);
  return NextResponse.json({ ok: true, data: { ...result, outbound, batches, notices, references } });
}

/** pg_cron `net.http_post`는 POST로 부른다 — 같은 자격·같은 일 */
export async function POST(request: Request) {
  return GET(request);
}
