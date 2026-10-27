import { NextRequest } from 'next/server';
import { timingSafeEqual } from 'crypto';
import { WORK_WORKER_SECRET } from '@/lib/config';
import { defaultWorkContext, fail, handleWork, ok } from '@/lib/work/server';
import { runWorker, newWorkerId } from '@/lib/work/runs/worker';

export const dynamic = 'force-dynamic';
export const maxDuration = 300;

/**
 * 업무 작업자 엔드포인트 — 대기·lease가 끝난 실행을 가져가 처리한다(ADR 0003).
 * 사람이 아니라 예약 작업(Vercel cron)·Supabase pg_cron이 부른다. WORK_WORKER_SECRET Bearer 상수 시간 비교가 유일한 자격이다.
 * 비밀값이 없으면 503(다른 길 — 화면의 execute·로컬 작업자 — 은 그대로 돈다). 응답에는 실행 id·결과 상태만 싣는다.
 */
function authorized(request: NextRequest): boolean {
  if (!WORK_WORKER_SECRET) return false;
  const got = Buffer.from(request.headers.get('authorization') ?? '');
  const want = Buffer.from(`Bearer ${WORK_WORKER_SECRET}`);
  return got.length === want.length && timingSafeEqual(got, want);
}

async function handle(request: NextRequest) {
  return handleWork(async () => {
    if (!WORK_WORKER_SECRET) return fail('NOT_CONFIGURED', '작업자 비밀값이 설정되지 않았습니다.', 503);
    if (!authorized(request)) return fail('UNAUTHORIZED', '인증이 필요합니다.', 401);
    const outcomes = await runWorker(defaultWorkContext(), { workerId: newWorkerId('cron'), limit: 5, budgetMs: 250_000 });
    return ok({ processed: outcomes.map((o) => ({ runId: o.runId, finish: o.finish, code: o.error?.code ?? null })) });
  });
}

/** Vercel 예약 작업은 GET으로 부른다 */
export async function GET(request: NextRequest) {
  return handle(request);
}

/** Supabase pg_cron(pg_net)·다른 스케줄러는 POST로 부른다 */
export async function POST(request: NextRequest) {
  return handle(request);
}
