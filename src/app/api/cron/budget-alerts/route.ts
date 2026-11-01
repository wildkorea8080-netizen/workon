import { NextResponse } from 'next/server';
import { timingSafeEqual } from 'crypto';
import { CRON_SECRET } from '@/lib/config';
import { budgetAlertDeps, runBudgetAlerts } from '@/lib/budget-alerts';

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

/**
 * 하루 한 번(vercel.json `crons`, 09:00 KST) 기관 예산 사용률을 보고 기준(80·90·100%) 알림 메일을 보낸다(`budget-alerts.ts`).
 * Vercel이 `Authorization: Bearer {CRON_SECRET}`를 실어 부른다. **이 비밀값이 유일한 자격**이라 같은지 상수 시간으로 비교한다.
 * 비밀값이 없으면 503. 같은 알림을 두 번 보내지 않는 것은 `budget_alerts` 유일 키가 맡는다
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
  const result = await runBudgetAlerts(budgetAlertDeps());
  return NextResponse.json({ ok: true, data: result });
}
