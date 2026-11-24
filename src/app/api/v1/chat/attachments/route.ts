import { NextRequest, NextResponse } from 'next/server';
import { clientIpFrom } from '@/lib/ip-access';
import { readJsonObject } from '@/lib/request-body';
import { handleOrgApiCall, orgApiDeps } from '@/lib/org-api/keys';
import { confirmChatAttachment } from '@/lib/org-api/chat-attachments';

export const dynamic = 'force-dynamic';
// 화면 첨부 확인과 같은 읽기(큰 엑셀·스캔 PDF는 NODA /parse) — 같은 300초
export const maxDuration = 300;

/**
 * 기관 API(0105) — 올린 첨부 확인·읽기(범위 chat). `{ attachmentId }` → `{ attachmentId, fileName, sizeBytes, status, error, summary }`.
 * 읽지 못한 파일도 200 + status 'failed'와 까닭. 확인한 attachmentId를 `POST /api/v1/chat`의 attachmentIds로 붙인다
 */
export async function POST(request: NextRequest) {
  try {
    const raw = await readJsonObject(request);
    const res = await handleOrgApiCall(orgApiDeps(), { authorization: request.headers.get('authorization'), ip: clientIpFrom(request.headers, request.ip) },
      'chat-attachment-confirm', (ctx) => confirmChatAttachment(ctx, raw),
      { failureMessage: '첨부를 확인하지 못했습니다. 잠시 뒤 다시 호출해 주세요.' });
    return NextResponse.json(res.body, { status: res.status, headers: { 'Cache-Control': 'no-store', ...res.headers } });
  } catch (error) {
    console.error('[v1 chat attachments]', error instanceof Error ? error.message : error);
    return NextResponse.json({ ok: false, error: { message: '첨부를 확인하지 못했습니다. 잠시 뒤 다시 호출해 주세요.' } }, { status: 500 });
  }
}
