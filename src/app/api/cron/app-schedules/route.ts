import { NextResponse } from 'next/server';
import { timingSafeEqual } from 'crypto';
import { CRON_SECRET } from '@/lib/config';
import { runDueSchedules, scheduleDeps } from '@/lib/apps/schedules';

export const dynamic = 'force-dynamic';
// 실행 하나가 단계 3개 + 최종 답까지 수 분 걸릴 수 있다 — 실행기의 시간 예산(180초)보다 길게
export const maxDuration = 300;

/**
 * 입력형 앱 예약 실행기(`src/lib/apps/schedules.ts`). pg_cron이 5분마다 `Authorization: Bearer {CRON_SECRET}`로 부른다
 * (Vercel Hobby 예약 작업은 하루 한 번·2개까지라 쓰지 않는다 — APP_SCHEDULES.md). **이 비밀값이 유일한 자격**이라 상수 시간으로 비교하고,
 * 하는 일은 DB에 이미 있는 차례가 된 예약을 조건부로 차지해 그 직원의 권한으로 실행하는 것뿐이다(요청값으로 대상을 고르지 않는다). 비밀값이 없으면 503
 */
export async function GET(request: Request) {
  if (!CRON_SECRET) {
    return NextResponse.json({ ok: false, error: { message: '예약 작업이 설정되지 않았습니다.' } }, { status: 503 });
  }
  const given = Buffer.from(request.headers.get('authorization') ?? '');
  const expected = Buffer.from(`Bearer ${CRON_SECRET}`);
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) {
    return NextResponse.json({ ok: false, error: { message: '인증이 필요합니다.' } }, { status: 401 });
  }
  const result = await runDueSchedules(scheduleDeps());
  return NextResponse.json({ ok: true, data: result });
}

/** pg_cron `net.http_post`가 POST로 부르기도 한다 — 같은 자격·같은 일 */
export async function POST(request: Request) {
  return GET(request);
}
