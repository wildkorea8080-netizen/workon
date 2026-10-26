import { NextResponse } from 'next/server';
import { timingSafeEqual } from 'crypto';
import { CRON_SECRET } from '@/lib/config';
import { replayNodaEvents } from '@/lib/noda-events';

export const dynamic = 'force-dynamic';

/**
 * 하루 한 번(vercel.json `crons`) 놓친 NODA 웹훅을 다시 받는다 — 아무도 문서 목록을 열지 않는 날의 받침.
 * Vercel이 `Authorization: Bearer {CRON_SECRET}`를 실어 부른다. **이 비밀값이 유일한 자격**이라 같은지 상수 시간으로 비교한다.
 * 비밀값이 없으면 503(목록을 열 때 다시 받기는 그대로 돈다). 1분 차지·시간 예산은 `replayNodaEvents`가 맡는다
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
  const result = await replayNodaEvents();
  return NextResponse.json({ ok: true, data: result });
}
