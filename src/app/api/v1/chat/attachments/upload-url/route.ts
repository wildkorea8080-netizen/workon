import { NextRequest, NextResponse } from 'next/server';
import { clientIpFrom } from '@/lib/ip-access';
import { readJsonObject } from '@/lib/request-body';
import { handleOrgApiCall, orgApiDeps } from '@/lib/org-api/keys';
import { issueChatAttachmentUrl } from '@/lib/org-api/chat-attachments';

export const dynamic = 'force-dynamic';

/**
 * 기관 API(0105) — 묻기에 붙일 파일 올리기 주소(범위 chat). `Authorization: Bearer wo_api_…`이 유일한 자격이다.
 * `{ fileName, size }` → `{ attachmentId, uploadUrl, method: 'PUT', headers, expiresAt }`. 첨부 주인은 키를 만든 기관 전체 관리자
 */
export async function POST(request: NextRequest) {
  try {
    const raw = await readJsonObject(request);
    const res = await handleOrgApiCall(orgApiDeps(), { authorization: request.headers.get('authorization'), ip: clientIpFrom(request.headers, request.ip) },
      'chat-attachment-upload-url', (ctx) => issueChatAttachmentUrl(ctx, raw),
      { failureMessage: '올리기 주소를 만들지 못했습니다. 잠시 뒤 다시 호출해 주세요.' });
    return NextResponse.json(res.body, { status: res.status, headers: { 'Cache-Control': 'no-store', ...res.headers } });
  } catch (error) {
    console.error('[v1 chat attachments upload-url]', error instanceof Error ? error.message : error);
    return NextResponse.json({ ok: false, error: { message: '올리기 주소를 만들지 못했습니다. 잠시 뒤 다시 호출해 주세요.' } }, { status: 500 });
  }
}
