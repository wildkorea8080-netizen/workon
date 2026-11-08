import { NextRequest, NextResponse } from 'next/server';
import { getServerAuthSession, isAdminSession } from '@/lib/auth';
import { getActorScope } from '@/lib/actor-scope';
import { supabaseAdmin } from '@/lib/supabaseAdmin';
import { pagedRows } from '@/lib/paged-select';
import { isOrgType } from '@/lib/org-types';
import { readOriginalText } from '@/lib/source-original';
import {
  REFERENCE_DOCUMENT_COLUMNS, documentReferences,
  type CommonReferenceRow, type ReferenceDeps, type ReferenceDocumentRow,
} from '@/lib/document-references';

export const dynamic = 'force-dynamic';
// 큰 한글·엑셀 원본을 다시 읽는다(스캔 PDF는 NODA로 보내지 않는다)
export const maxDuration = 60;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** 후보로 읽는 기관 문서 행 상한 */
const CANDIDATE_CAP = 5000;

function jsonError(message: string, status: number) {
  return NextResponse.json({ ok: false, error: { message } }, { status });
}

const deps: ReferenceDeps = {
  async loadDocument(id, organizationId) {
    const { data, error } = await supabaseAdmin.from('documents').select(REFERENCE_DOCUMENT_COLUMNS).eq('id', id).eq('organization_id', organizationId).maybeSingle();
    if (error) throw new Error(`documents: ${error.message}`);
    return (data as unknown as ReferenceDocumentRow | null) ?? null;
  },
  readText: readOriginalText,
  async listDocuments(organizationId) {
    const result = await pagedRows<ReferenceDocumentRow>((from, to, withCount) =>
      supabaseAdmin
        .from('documents')
        .select(`${REFERENCE_DOCUMENT_COLUMNS}, agent:agents(name, deleted_at)`, withCount ? { count: 'exact' } : undefined)
        .eq('organization_id', organizationId)
        .order('id')
        .range(from, to) as unknown as PromiseLike<{ data: ReferenceDocumentRow[] | null; error: { message: string } | null; count?: number | null }>,
    { cap: CANDIDATE_CAP });
    if (result.error) throw new Error(`documents: ${result.error.message}`);
    return { rows: result.data, truncated: result.truncated };
  },
  async listCommon(organizationId) {
    const { data: org, error } = await supabaseAdmin.from('organizations').select('type').eq('id', organizationId).maybeSingle();
    if (error) throw new Error(`organizations: ${error.message}`);
    const type = (org as { type?: unknown } | null)?.type;
    if (!isOrgType(type)) return [];
    // API는 한 번에 1,000행까지만 돌려준다 — 쪽마다 끝까지 읽는다
    const result = await pagedRows<CommonReferenceRow>((from, to, withCount) =>
      supabaseAdmin
        .from('common_documents')
        .select('id, title, file_name, edition_year, noda_status, retired_at', withCount ? { count: 'exact' } : undefined)
        .eq('org_type', type)
        .order('id')
        .range(from, to) as unknown as PromiseLike<{ data: CommonReferenceRow[] | null; error: { message: string } | null; count?: number | null }>,
    { cap: CANDIDATE_CAP });
    if (result.error) throw new Error(`common_documents: ${result.error.message}`);
    return result.data;
  },
};

/**
 * 문서 참조 관계(2026-11-08) — 문서 원본에서 「…」·『…』로 인용한 이름을 찾아 기관 문서(요청자가 볼 수 있는 비서 문서)·
 * 기관 유형의 공통 자료실과 맞춘다. 모델을 부르지 않는다. 관리자만(문서 화면), 볼 수 없는 문서는 404
 */
export async function GET(_request: NextRequest, { params }: { params: { id: string } }) {
  const session = await getServerAuthSession();
  if (!session?.user?.id) return jsonError('로그인이 필요합니다.', 401);
  if (!isAdminSession(session)) return jsonError('관리자 권한이 필요합니다.', 403);
  const actor = await getActorScope(session);
  if (!actor?.organizationId) return jsonError('소속 기관을 확인할 수 없습니다.', 403);
  if (!UUID.test(params.id)) return jsonError('문서를 찾을 수 없습니다.', 404);
  try {
    const outcome = await documentReferences(params.id, actor, deps);
    if (!outcome.ok) return jsonError(outcome.message, outcome.status);
    return NextResponse.json({ ok: true, data: outcome.data }, { headers: { 'Cache-Control': 'private, no-store' } });
  } catch (error) {
    console.error('[documents references]', params.id, error instanceof Error ? error.message : error);
    return jsonError('참조 문서를 찾는 중 오류가 발생했습니다. 잠시 뒤 다시 시도해 주세요.', 503);
  }
}
