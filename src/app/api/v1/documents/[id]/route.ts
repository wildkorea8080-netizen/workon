import { NextRequest, NextResponse } from 'next/server';
import { clientIpFrom } from '@/lib/ip-access';
import { handleOrgApiCall, orgApiDeps } from '@/lib/org-api/keys';
import { deleteOrgApiDocument } from '@/lib/org-api/document-delete';

export const dynamic = 'force-dynamic';

/**
 * 기관 API(0104) — 문서 지우기(범위 documents_delete). `Authorization: Bearer wo_api_…`이 유일한 자격이다.
 * 이 기관의 공식·부서 비서에 붙은 문서만, 관리자 문서 화면과 같은 길(NODA → 행 → 원본)로 지운다. 되돌릴 수 없다.
 * 없거나 지울 수 없는 문서·이미 지운 문서는 404, NODA를 못 비우면 502(행은 '지우는 중'으로 남고 같은 호출로 다시 지운다)
 */
export async function DELETE(request: NextRequest, { params }: { params: { id: string } }) {
  try {
    const res = await handleOrgApiCall(orgApiDeps(), { authorization: request.headers.get('authorization'), ip: clientIpFrom(request.headers, request.ip) },
      'documents-delete', (ctx) => deleteOrgApiDocument(ctx, params.id),
      { failureMessage: '문서를 지우지 못했습니다. 잠시 뒤 다시 호출해 주세요(같은 호출을 다시 보내도 됩니다).' });
    return NextResponse.json(res.body, { status: res.status, headers: { 'Cache-Control': 'no-store', ...res.headers } });
  } catch (error) {
    console.error('[v1 documents DELETE]', error instanceof Error ? error.message : error);
    return NextResponse.json({ ok: false, error: { message: '문서를 지우지 못했습니다. 잠시 뒤 다시 호출해 주세요.' } }, { status: 500 });
  }
}
