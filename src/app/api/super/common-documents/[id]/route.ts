import { NextRequest, NextResponse } from 'next/server';
import { getSuperAdminFromRequest } from '@/lib/super-auth';
import { supabaseAdmin } from '@/lib/supabaseAdmin';
import { deleteCommonDocument } from '@/lib/common-documents';
import { writeAuditRow } from '@/lib/audit-write';

export const dynamic = 'force-dynamic';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const NODA_DELETE_FAILED_MESSAGE = '문서 보관소에서 지우지 못했습니다. 잠시 뒤 다시 지워 주세요.';

function jsonError(message: string, status: number) {
  return NextResponse.json({ ok: false, error: { message } }, { status });
}

/** 공통 문서 하나를 지운다 — 순서 NODA → 행 → 원본. NODA를 못 지우면 행을 `deleting`으로 남기고 502(다시 지울 수 있다) */
export async function DELETE(request: NextRequest, { params }: { params: { id: string } }) {
  const admin = getSuperAdminFromRequest(request);
  if (!admin) return jsonError('인증이 필요합니다.', 401);

  try {
    if (!UUID.test(params.id)) return jsonError('문서를 찾을 수 없습니다.', 404);

    // 감사 기록에 남길 값은 지우기 전에 읽는다(이름·유형·연도·사용 조건 — 설계 4절. 파일 경로는 남기지 않는다)
    const { data: before, error: beforeError } = await supabaseAdmin
      .from('common_documents')
      .select('title, org_type, edition_year, usage_terms')
      .eq('id', params.id)
      .maybeSingle();
    // 못 읽으면 지우지 않는다(2026-11-20 — 예전엔 그대로 지워, 되돌릴 수 없는 삭제의 감사 기록에 무엇을 지웠는지가 비었다)
    if (beforeError) return jsonError('문서를 지금 읽지 못해 지우지 않았습니다. 잠시 뒤 다시 지워 주세요.', 503);

    const result = await deleteCommonDocument(params.id);
    if (!result.ok) {
      if (result.status === 404) return jsonError('문서를 찾을 수 없습니다.', 404);
      return jsonError(NODA_DELETE_FAILED_MESSAGE, 502);
    }

    await writeAuditRow('super_admin_logs', {
      admin_user_id: admin.sub,
      action: 'common_document_deleted',
      target_type: 'common_document',
      target_id: params.id,
      after_data: before
        ? {
            title: before.title,
            org_type: before.org_type,
            edition_year: before.edition_year,
            usage_terms: before.usage_terms,
          }
        : {},
    }, 'common_document_deleted');

    return NextResponse.json({ ok: true, data: { id: params.id } });
  } catch (error) {
    console.error('[super common-documents delete]', error);
    return jsonError('서버 오류가 발생했습니다.', 500);
  }
}
