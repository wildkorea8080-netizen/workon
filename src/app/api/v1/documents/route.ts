import { NextRequest, NextResponse } from 'next/server';
import { clientIpFrom } from '@/lib/ip-access';
import { readJsonObject } from '@/lib/request-body';
import { handleOrgApiCall, orgApiDeps } from '@/lib/org-api/keys';
import { documentsReport } from '@/lib/org-api/documents';
import { createOrgApiDocument } from '@/lib/org-api/document-write';

export const dynamic = 'force-dynamic';
// 등록(POST)이 읽기를 건다 — NODA 비동기 넣기라 대개 바로 돌아오지만, 비동기를 모르는 NODA는 다 읽고 답한다(문서 읽기 라우트와 같은 값)
export const maxDuration = 300;

/**
 * 기관 API(0075·0099) — 문서함 목록(읽기 상태·판·시행일·근거로 쓰는지·태그). `Authorization: Bearer wo_api_…`(범위 documents)이 유일한 자격이다.
 * 본문·요약·원본·저장소 경로·올린 사람은 싣지 않고, 나만의 비서·지운 비서의 문서는 내지 않는다. `?status=&agent=&limit=&cursor=`
 */
export async function GET(request: NextRequest) {
  try {
    const sp = request.nextUrl.searchParams;
    const res = await handleOrgApiCall(orgApiDeps(), { authorization: request.headers.get('authorization'), ip: clientIpFrom(request.headers, request.ip) },
      'documents', (ctx) => documentsReport(ctx, { status: sp.get('status'), agent: sp.get('agent'), cursor: sp.get('cursor'), limit: sp.get('limit') }));
    return NextResponse.json(res.body, { status: res.status, headers: { 'Cache-Control': 'no-store', ...res.headers } });
  } catch (error) {
    console.error('[v1 documents]', error instanceof Error ? error.message : error);
    return NextResponse.json({ ok: false, error: { message: '문서함 목록을 읽지 못했습니다. 잠시 뒤 다시 호출해 주세요.' } }, { status: 500 });
  }
}

/**
 * 기관 API(0100) — 올린 문서 등록·읽기 시작(범위 documents_write). 먼저 `POST /api/v1/documents/upload-url`로 주소를 받아 파일을 PUT한 뒤
 * `{ path, agentId, fileName, fileType?, title?, replacesId?, effectiveFrom?, tags?, visibility? }`. 화면 확인과 같은 검사, 성공 201
 */
export async function POST(request: NextRequest) {
  try {
    const raw = await readJsonObject(request);
    const res = await handleOrgApiCall(orgApiDeps(), { authorization: request.headers.get('authorization'), ip: clientIpFrom(request.headers, request.ip) },
      'documents-create', (ctx) => createOrgApiDocument(ctx, raw),
      { successStatus: 201, failureMessage: '문서를 등록하지 못했습니다. 잠시 뒤 다시 호출해 주세요(같은 path로 다시 보내도 됩니다).' });
    return NextResponse.json(res.body, { status: res.status, headers: { 'Cache-Control': 'no-store', ...res.headers } });
  } catch (error) {
    console.error('[v1 documents POST]', error instanceof Error ? error.message : error);
    return NextResponse.json({ ok: false, error: { message: '문서를 등록하지 못했습니다. 잠시 뒤 다시 호출해 주세요.' } }, { status: 500 });
  }
}
