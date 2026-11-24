import { NextRequest, NextResponse } from 'next/server';
import { clientIpFrom } from '@/lib/ip-access';
import { readJsonObject } from '@/lib/request-body';
import { handleOrgApiCall, orgApiDeps } from '@/lib/org-api/keys';
import { askOrgApiChat } from '@/lib/org-api/chat';

export const dynamic = 'force-dynamic';
// 문서 근거·도구 조회·모델 답이 한 호출 안에 있다 — 대화 라우트(/api/chat)와 같은 300초
export const maxDuration = 300;

/**
 * 기관 API(0101) — 비서에게 묻기(범위 chat). `Authorization: Bearer wo_api_…`이 유일한 자격이다.
 * `{ agentId, question, conversationId?, skipDocuments?, tags?, stream? }` → `{ conversationId, messageId, continuable, answer, sources, links, files, numberCheck, documentsSkipped }`.
 * 묻는 사람은 키를 만든 기관 전체 관리자 — 대화는 그 사람의 대화(`[API] ` 제목)로 남고 그 사람의 한도를 쓴다. 비서는 이 기관의 공식·부서 대화형 비서만
 */
export async function POST(request: NextRequest) {
  try {
    const raw = await readJsonObject(request);
    const res = await handleOrgApiCall(orgApiDeps(), { authorization: request.headers.get('authorization'), ip: clientIpFrom(request.headers, request.ip) },
      'chat', (ctx) => askOrgApiChat(ctx, raw),
      { failureMessage: '답을 만들지 못했습니다. 잠시 뒤 다시 호출해 주세요.' });
    // stream: true — 확인·준비를 마친 뒤의 SSE 흐름(start → delta·tool … → done | error)
    if (res.stream) {
      return new Response(res.stream, {
        status: res.status,
        headers: { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-store, no-transform', Connection: 'keep-alive', 'X-Accel-Buffering': 'no', ...res.headers },
      });
    }
    return NextResponse.json(res.body, { status: res.status, headers: { 'Cache-Control': 'no-store', ...res.headers } });
  } catch (error) {
    console.error('[v1 chat]', error instanceof Error ? error.message : error);
    return NextResponse.json({ ok: false, error: { message: '답을 만들지 못했습니다. 잠시 뒤 다시 호출해 주세요.' } }, { status: 500 });
  }
}
