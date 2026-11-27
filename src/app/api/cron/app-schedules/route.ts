import { NextResponse } from 'next/server';
import { APP_URL } from '@/lib/config';
import { workerSecretRejection } from '@/lib/cron-auth';
import { dispatchBatchLanes, laneBaseUrl, pendingBatchRows } from '@/lib/apps/batch-lanes';
import { runDueSchedules, scheduleDeps } from '@/lib/apps/schedules';
import { recordRunnerHeartbeat } from '@/lib/apps/schedule-health';
import { dispatchDueDeliveries, outboundDeps } from '@/lib/apps/outbound/deliver';
import { batchDeps, batchExtraLanes, runDueBatchItems } from '@/lib/apps/batches';
import { runOutboundNotices } from '@/lib/apps/outbound/notices';
import { autoIndexReferences } from '@/lib/document-references';
import { autoIndexDeps } from '@/lib/document-references-db';
import { budgetAlertDeps, quickBudgetAlertDue, runBudgetAlerts } from '@/lib/budget-alerts';
import { criticalAlertDeps, runCriticalAlert } from '@/lib/critical-alert';
import { fillLibraryContent, libraryFillDeps } from '@/lib/library-content-fill';
import { dataPrefillDeps, prefillDataExtracts } from '@/lib/capabilities/agent-data-files';
import { purgePublicAskLogs } from '@/lib/public-ask/purge';

export const dynamic = 'force-dynamic';
// 실행 하나가 단계 3개 + 최종 답까지 수 분 걸릴 수 있다 — 실행기의 시간 예산(180초)보다 길게
export const maxDuration = 300;

/**
 * 입력형 앱 예약 실행기(`src/lib/apps/schedules.ts`). Supabase pg_cron이 5분마다 부른다(Vercel Hobby 예약 작업은 하루 한 번·2개까지라 쓰지 않는다 — APP_SCHEDULES.md).
 * 자격은 Bearer 비밀값 하나 — **업무 작업자와 같은 `WORK_WORKER_SECRET`**(pg_cron이 Vault `work_worker_secret`으로 이미 싣는 값) 또는 `CRON_SECRET`.
 * 둘 다 서버 예약 작업용 비밀값이고 상수 시간으로 비교한다. 하는 일은 DB에 이미 있는 차례가 된 예약을 조건부로 차지해 그 직원의 권한으로 실행하는 것뿐이다
 * (요청값으로 대상을 고르지 않는다). 두 비밀값이 모두 없으면 503
 */
export async function GET(request: Request) {
  // 자격 — `src/lib/cron-auth.ts`(2026-11-26 뽑음 — 일괄 실행 전용 실행기와 같다)
  const rejected = workerSecretRejection(request);
  if (rejected) return rejected;
  const header = request.headers.get('authorization') ?? '';
  // '살아 있음' 도장 — 하루 한 번 Vercel 예약 작업이 이 도장으로 pg_cron이 멈췄는지 본다(schedule-health.ts). 실패해도 실행은 이어 간다
  await recordRunnerHeartbeat(Date.now());
  // 앱 결과 보내기(0076)·일괄 실행(0077) — 예약 실행과 나란히(예약의 시간 예산을 쓰지 않게). 던지지 않는다
  // 보내기 알림(2026-11-10, 0081) — 그만둔 보내기는 기관 전체 관리자에게(보낼 곳마다 6시간에 한 번), 확인 기다림은 실행한 직원에게(결과마다 한 번)
  // 문서 참조 색인 자동 채우기(2026-11-12) — 색인 없는 문서 두 개씩(원본 읽기만, 모델 없음). 던지지 않는다
  // 예산 알림 빠른 확인(2026-11-12) — 15분마다 새로 넘은 기준만, 조용히(실패 다시 보내기는 하루 한 번 실행이). 던져도 실행기는 이어 간다
  const now = Date.now();
  // 자료함 내용 글 채우기(2026-11-25, 0120) — 내용을 아직 확인하지 않은 자료함 파일 두 개씩(사본 읽기만, 모델 없음). 던지지 않는다
  // 일괄 실행 전용 실행기 더 띄우기(2026-11-26) — 기다리는 줄이 많으면 `/api/cron/app-batches`를 1~3번 더 불러 나란히(못 세거나 못 띄우면 이 실행기 몫만)
  const lanes = pendingBatchRows().then((pending) => dispatchBatchLanes({ baseUrl: laneBaseUrl(APP_URL), authorization: header, lanes: batchExtraLanes(pending) })).catch(() => null);
  // 비서 데이터 파일 미리 읽어 두기(2026-11-26) — 아직 읽어 두지 않은 표 파일 두 개씩(원본 읽기만, 모델 없음). 던지지 않는다
  const [outbound, batches, result, notices, references, budget, critical, library, batchLanes, dataFiles, publicAsk] = await Promise.all([
    dispatchDueDeliveries(outboundDeps(), { limit: 20, budgetMs: 60_000 }),
    runDueBatchItems(batchDeps()),
    runDueSchedules(scheduleDeps()),
    runOutboundNotices().catch(() => null),
    autoIndexReferences(autoIndexDeps()).catch(() => null),
    quickBudgetAlertDue(now) ? runBudgetAlerts(budgetAlertDeps(), 20_000, { quick: true }).catch(() => null) : Promise.resolve(null),
    // 심각한 운영 기록 메일(2026-11-17) — 한 시간에 한 번까지, 던지지 않음
    runCriticalAlert(criticalAlertDeps()).catch(() => null),
    libraryFillDeps().then(fillLibraryContent).catch(() => null),
    lanes,
    prefillDataExtracts(dataPrefillDeps()).catch(() => null),
    // 시민 상담 기록 30일 보관(0136) — 지난 줄을 지운다, 던지지 않음
    purgePublicAskLogs(now).catch(() => null),
  ]);
  return NextResponse.json({ ok: true, data: { ...result, outbound, batches, batchLanes, notices, references, budget, critical, library, dataFiles, publicAsk } });
}

/** pg_cron `net.http_post`는 POST로 부른다 — 같은 자격·같은 일 */
export async function POST(request: Request) {
  return GET(request);
}
