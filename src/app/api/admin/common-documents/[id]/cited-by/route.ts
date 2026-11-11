import { NextResponse } from 'next/server';
import { getServerAuthSession, isAdminSession } from '@/lib/auth';
import { getActorScope } from '@/lib/actor-scope';
import { supabaseAdmin } from '@/lib/supabaseAdmin';
import { isOrgType } from '@/lib/org-types';
import { commonDocumentCitedBy, type CommonCitedByRow } from '@/lib/document-references';
import { referenceDeps } from '@/lib/document-references-db';

export const dynamic = 'force-dynamic';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function jsonError(message: string, status: number) {
  return NextResponse.json({ ok: false, error: { message } }, { status });
}

/**
 * 공통 기준 문서를 인용하는 이 기관 문서(2026-11-12) — 정부 기준이 바뀌었을 때 함께 고칠 기관 문서를 찾는다.
 * 관리자만, 이 기관 유형의 공통 문서만(다른 유형은 404), 인용 문서는 요청자가 볼 수 있는 것만. 참조 색인으로만 찾는다(모델 없음)
 */
export async function GET(_request: Request, { params }: { params: { id: string } }) {
  const session = await getServerAuthSession();
  if (!isAdminSession(session)) return jsonError('관리자 권한이 필요합니다.', 403);
  try {
    const actor = await getActorScope(session!);
    if (!actor?.organizationId) return jsonError('소속 기관을 찾을 수 없습니다.', 403);
    if (!UUID.test(params.id)) return jsonError('문서를 찾을 수 없습니다.', 404);
    const refs = referenceDeps(actor);
    const outcome = await commonDocumentCitedBy(params.id, actor, {
      async loadCommon(id) {
        const { data, error } = await supabaseAdmin.from('common_documents').select('id, org_type, title, file_name, edition_year').eq('id', id).maybeSingle();
        if (error) throw new Error(`common_documents: ${error.message}`);
        return (data as CommonCitedByRow | null) ?? null;
      },
      async orgType(organizationId) {
        const { data, error } = await supabaseAdmin.from('organizations').select('type').eq('id', organizationId).maybeSingle();
        if (error) throw new Error(`organizations: ${error.message}`);
        const type = (data as { type?: unknown } | null)?.type;
        return isOrgType(type) ? type : null;
      },
      listCiting: refs.listCiting,
      listSimilarCiting: refs.listSimilarCiting,
      coverage: refs.coverage,
    });
    if (!outcome.ok) return jsonError(outcome.message, outcome.status);
    return NextResponse.json({ ok: true, data: outcome.data });
  } catch (error) {
    console.error('[admin common-documents cited-by]', params.id, error instanceof Error ? error.message : error);
    return jsonError('인용하는 문서를 지금 불러올 수 없습니다. 잠시 뒤 다시 시도해 주세요.', 503);
  }
}
