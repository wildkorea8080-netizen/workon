import { NextRequest, NextResponse } from 'next/server';
import { getSuperAdminFromRequest } from '@/lib/super-auth';
import { commonCitationCounts } from '@/lib/document-references-db';

export const dynamic = 'force-dynamic';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function jsonError(message: string, status: number) {
  return NextResponse.json({ ok: false, error: { message } }, { status });
}

/**
 * 공통 문서를 인용하는 기관(2026-11-12) — 슈퍼관리자만. 그 유형의 기관마다 같은 이름·이름 비슷으로 인용한 **문서 수만**(문서 이름 없음).
 * 기준의 새 판을 올릴 때 영향 받는 기관을 본다. 참조 색인으로만 센다(모델 없음)
 */
export async function GET(request: NextRequest, { params }: { params: { id: string } }) {
  const admin = getSuperAdminFromRequest(request);
  if (!admin) return jsonError('인증이 필요합니다.', 401);
  try {
    if (!UUID.test(params.id)) return jsonError('문서를 찾을 수 없습니다.', 404);
    const data = await commonCitationCounts(params.id.toLowerCase());
    if (!data) return jsonError('문서를 찾을 수 없습니다.', 404);
    return NextResponse.json({ ok: true, data });
  } catch (error) {
    console.error('[super common-documents cited-by]', params.id, error instanceof Error ? error.message : error);
    return jsonError('인용하는 기관을 지금 셀 수 없습니다. 잠시 뒤 다시 시도해 주세요.', 503);
  }
}
