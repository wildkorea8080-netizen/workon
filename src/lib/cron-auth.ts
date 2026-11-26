// src/lib/cron-auth.ts
// 서버 예약 작업 라우트의 자격(2026-11-26 — 앱 예약 실행기에서 뽑음). Bearer 비밀값 하나 — 업무 작업자와 같은 `WORK_WORKER_SECRET`
// (pg_cron이 Vault로 싣는 값) 또는 `CRON_SECRET`. 상수 시간으로 비교하고, 둘 다 없으면 503.
import { NextResponse } from 'next/server';
import { timingSafeEqual } from 'crypto';
import { CRON_SECRET, WORK_WORKER_SECRET } from '@/lib/config';

/** Bearer 비밀값이 이 값과 같은가(상수 시간 비교). 값이 비었으면 거짓 */
export function bearerMatches(header: string, secret: string | undefined): boolean {
  if (!secret) return false;
  const given = Buffer.from(header);
  const expected = Buffer.from(`Bearer ${secret}`);
  return given.length === expected.length && timingSafeEqual(given, expected);
}

/** 자격이 맞으면 null, 아니면 돌려줄 응답(503 — 설정 없음 / 401) */
export function workerSecretRejection(request: Request): Response | null {
  if (!WORK_WORKER_SECRET && !CRON_SECRET) {
    return NextResponse.json({ ok: false, error: { message: '예약 작업이 설정되지 않았습니다.' } }, { status: 503 });
  }
  const header = request.headers.get('authorization') ?? '';
  if (!bearerMatches(header, WORK_WORKER_SECRET) && !bearerMatches(header, CRON_SECRET)) {
    return NextResponse.json({ ok: false, error: { message: '인증이 필요합니다.' } }, { status: 401 });
  }
  return null;
}
