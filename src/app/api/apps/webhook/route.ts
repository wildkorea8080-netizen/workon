import { NextResponse } from 'next/server';
import { handleWebhookCall, webhookDeps } from '@/lib/apps/webhooks';
import { IDEMPOTENCY_HEADER, WEBHOOK_MAX_BODY_WITH_FILES_BYTES } from '@/lib/apps/webhook-spec';
import { logSystem } from '@/lib/logger';

export const dynamic = 'force-dynamic';
// 실행 하나가 단계 3개 + 최종 답까지 수 분 걸릴 수 있다 — 호출한 쪽은 끝날 때까지 기다린다
export const maxDuration = 300;

/**
 * 입력형 앱 외부 연동 호출(`src/lib/apps/webhooks.ts`). 로그인 없이 열리는 주소라 **연동 토큰(Bearer)이 유일한 자격**이다 —
 * DB에는 토큰의 SHA-256만 있고, 차지 함수가 유효·간격(60초)·하루 상한(100)을 원자적으로 본다. 그 직원의 권한으로 앱을 실행하고
 * 상태와 대화 id만 돌려준다(앱 결과 글은 싣지 않는다). 본문 `files`로 파일을 함께 보낼 수 있다(3개·풀어서 3MB, 2026-11-08)
 */
export async function POST(request: Request) {
  const declared = Number(request.headers.get('content-length') ?? '0');
  if (Number.isFinite(declared) && declared > WEBHOOK_MAX_BODY_WITH_FILES_BYTES) {
    return NextResponse.json({ ok: false, error: { message: '보내는 내용이 너무 큽니다(파일 합계 3MB·입력 64KB까지).' } }, { status: 413 });
  }
  try {
    const result = await handleWebhookCall(webhookDeps(), { authorization: request.headers.get('authorization'), idempotencyKey: request.headers.get(IDEMPOTENCY_HEADER), bodyText: await request.text() });
    return NextResponse.json(result.body, { status: result.status, headers: result.headers });
  } catch (error) {
    await logSystem({ level: 'error', category: 'api', message: '앱 연동 호출 처리 실패', details: { error: error instanceof Error ? error.message.slice(0, 200) : 'unknown' } });
    return NextResponse.json({ ok: false, error: { message: '잠시 뒤 다시 보내 주세요.' } }, { status: 500 });
  }
}
