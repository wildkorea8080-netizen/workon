import { NextRequest, NextResponse } from 'next/server';
import { randomUUID } from 'crypto';
import { getSuperAdminFromRequest } from '@/lib/super-auth';
import { supabaseAdmin } from '@/lib/supabaseAdmin';
import { SUPABASE_DOCUMENTS_BUCKET } from '@/lib/config';
import { checkUploadFile } from '@/lib/document-upload';
import { commonStoragePath } from '@/lib/common-upload';
import { isOrgType } from '@/lib/org-types';

export const dynamic = 'force-dynamic';

function jsonError(message: string, status: number) {
  return NextResponse.json({ ok: false, error: { message } }, { status });
}

/**
 * ① 공통 문서 업로드 주소(운영자). 원본은 브라우저가 저장소에 직접 올린다(Vercel 요청 본문 상한 4.5MB).
 * 경로는 서버가 정한다. 같은 검사를 확인(POST /api/super/common-documents)이 다시 한다.
 */
export async function POST(request: NextRequest) {
  const admin = getSuperAdminFromRequest(request);
  if (!admin) return jsonError('인증이 필요합니다.', 401);

  try {
    let body: { file_name?: unknown; size?: unknown; file_type?: unknown; org_type?: unknown };
    try {
      body = await request.json();
    } catch {
      return jsonError('요청 형식이 올바르지 않습니다.', 400);
    }

    if (!isOrgType(body.org_type)) return jsonError('기관 유형을 골라 주세요.', 400);

    const file = checkUploadFile({
      fileName: typeof body.file_name === 'string' ? body.file_name : '',
      size: typeof body.size === 'number' ? body.size : Number.NaN,
      mimeType: typeof body.file_type === 'string' ? body.file_type : '',
    });
    if (!file.ok) return jsonError(file.message, file.status);

    const path = commonStoragePath({ orgType: body.org_type, now: Date.now(), id: randomUUID(), ext: file.ext });
    const { data, error } = await supabaseAdmin.storage.from(SUPABASE_DOCUMENTS_BUCKET).createSignedUploadUrl(path);
    if (error || !data?.token) {
      console.error('[super common-documents upload-url] 업로드 주소 발급 실패:', error?.message);
      return jsonError('업로드 주소를 만들지 못했습니다. 잠시 뒤 다시 시도해 주세요.', 500);
    }

    return NextResponse.json({ ok: true, data: { path, token: data.token } });
  } catch (error) {
    console.error('[super common-documents upload-url]', error);
    return jsonError('서버 오류가 발생했습니다.', 500);
  }
}
