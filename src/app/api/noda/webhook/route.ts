import { NextResponse } from 'next/server';
import { NODA_WEBHOOK_SECRET } from '@/lib/config';
import { applyNodaEvent, verifyNodaSignature } from '@/lib/noda-webhook';

export const dynamic = 'force-dynamic';

/**
 * NODA 웹훅 받는 곳 — 읽기 결과 알림(`document.ready`·`document.unreadable`·`document.failed`).
 *
 * 로그인 없이 열린다(NODA가 부른다). **서명이 유일한 자격**이라 본문을 받은 글 그대로 서명과 맞춰 본다.
 * NODA는 5초 안에 2xx가 아니면 같은 알림을 두 번 더 보낸다 — 처리는 조건부 갱신이라 겹쳐도 해가 없다.
 * DB 오류처럼 다시 받으면 될 실패는 500으로 돌려 NODA가 다시 보내게 한다.
 */
export async function POST(request: Request) {
  if (!NODA_WEBHOOK_SECRET) {
    return NextResponse.json({ ok: false, error: { message: '웹훅이 설정되지 않았습니다.' } }, { status: 503 });
  }

  const rawBody = await request.text();
  const verified = verifyNodaSignature({
    rawBody,
    timestamp: request.headers.get('x-noda-timestamp'),
    signature: request.headers.get('x-noda-signature'),
    secret: NODA_WEBHOOK_SECRET,
    now: Date.now(),
  });
  if (!verified.ok) {
    return NextResponse.json({ ok: false, error: { message: '서명이 맞지 않습니다.' } }, { status: 401 });
  }

  let event: unknown;
  try {
    event = JSON.parse(rawBody);
  } catch {
    return NextResponse.json({ ok: false, error: { message: '본문을 읽지 못했습니다.' } }, { status: 400 });
  }
  if (!event || typeof event !== 'object') {
    return NextResponse.json({ ok: false, error: { message: '본문을 읽지 못했습니다.' } }, { status: 400 });
  }

  try {
    const outcome = await applyNodaEvent(event as Record<string, unknown>);
    return NextResponse.json({ ok: true, data: { outcome } });
  } catch (error) {
    console.error('[noda-webhook] 처리 실패', error instanceof Error ? error.message : error);
    return NextResponse.json({ ok: false, error: { message: '처리하지 못했습니다.' } }, { status: 500 });
  }
}
