import { NextRequest, NextResponse } from 'next/server';
import { clientIpFrom } from '@/lib/ip-access';
import { readJsonObject } from '@/lib/request-body';
import { handleOrgApiCall, orgApiDeps } from '@/lib/org-api/keys';
import { issueDocumentUploadUrl } from '@/lib/org-api/document-write';

export const dynamic = 'force-dynamic';

/**
 * 기관 API(0100) — 문서 올리기 주소(범위 documents_write). `Authorization: Bearer wo_api_…`이 유일한 자격이다.
 * `{ agentId, fileName, size, fileType? }` → `{ path, uploadUrl, method: 'PUT', headers, expiresAt }`. 파일은 uploadUrl에 바이트 그대로 PUT하고
 * 10분 안에 `POST /api/v1/documents`로 등록한다. 비서는 이 기관의 공식·부서 비서만(나만의 비서 아님)
 */
export async function POST(request: NextRequest) {
  try {
    const raw = await readJsonObject(request);
    const res = await handleOrgApiCall(orgApiDeps(), { authorization: request.headers.get('authorization'), ip: clientIpFrom(request.headers, request.ip) },
      'documents-upload-url', (ctx) => issueDocumentUploadUrl(ctx, raw),
      { failureMessage: '올리기 주소를 만들지 못했습니다. 잠시 뒤 다시 호출해 주세요.' });
    return NextResponse.json(res.body, { status: res.status, headers: { 'Cache-Control': 'no-store', ...res.headers } });
  } catch (error) {
    console.error('[v1 documents upload-url]', error instanceof Error ? error.message : error);
    return NextResponse.json({ ok: false, error: { message: '올리기 주소를 만들지 못했습니다. 잠시 뒤 다시 호출해 주세요.' } }, { status: 500 });
  }
}
