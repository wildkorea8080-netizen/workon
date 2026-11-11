import { NextResponse } from 'next/server';
import { handleWebhookBatchStatus, webhookStatusDeps } from '@/lib/apps/webhook-status';
import { logSystem } from '@/lib/logger';

export const dynamic = 'force-dynamic';

/**
 * 비동기 연동 호출(0087)의 묶음 상태 묻기(`src/lib/apps/webhook-status.ts`). 로그인 없이 열리는 주소라 **연동 토큰(Bearer)이 유일한 자격**이고,
 * 그 연동이 넣은 묶음만 보인다(아니면 404). 상태·대화 id·오류 안내·결과 보내기 상태만 — 결과 글·입력값은 싣지 않는다
 */
export async function GET(request: Request, { params }: { params: { id: string } }) {
  try {
    const result = await handleWebhookBatchStatus(webhookStatusDeps(), { authorization: request.headers.get('authorization'), batchId: params.id });
    return NextResponse.json(result.body, { status: result.status, headers: result.headers });
  } catch (error) {
    await logSystem({ level: 'error', category: 'api', message: '앱 연동 상태 묻기 실패', details: { error: error instanceof Error ? error.message.slice(0, 200) : 'unknown' } });
    return NextResponse.json({ ok: false, error: { message: '잠시 뒤 다시 물어 주세요.' } }, { status: 500 });
  }
}
