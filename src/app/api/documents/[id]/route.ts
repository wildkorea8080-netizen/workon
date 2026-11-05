import { NextRequest, NextResponse } from 'next/server';
import { getServerAuthSession } from '@/lib/auth';
import { getActorScope } from '@/lib/actor-scope';
import { supabaseAdmin } from '@/lib/supabaseAdmin';
import { documentTagAccess } from '@/lib/document-tag-access';
import { applyVocabulary, normalizeDocumentTags } from '@/lib/document-tags';
import { loadTagVocabulary } from '@/lib/document-tag-vocabulary';

export const dynamic = 'force-dynamic';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function jsonError(message: string, status: number) {
  return NextResponse.json({ ok: false, error: { message } }, { status });
}

/**
 * 문서 태그 고치기(0060) — `PATCH { tags }`(배열 또는 쉼표로 이은 글). 태그는 검색·거르기용 분류라 판을 남기지 않는다.
 * 요청자 기관의 문서이고 요청자가 볼 수 있어야 한다(안 보이면 404). 고칠 수 있는 사람: 그 비서를 고칠 수 있는 사람,
 * 또는 그 문서의 부서를 관리하는 관리자. 기관 분류표(0061)에 있는 태그는 분류표 표기로 맞추고, '분류표의 태그만'이 켜져 있으면
 * 분류표에 없는 태그는 400으로 거절한다(분류표를 못 읽으면 저장하지 않는다 — 제한을 조용히 건너뛰지 않게).
 */
export async function PATCH(request: NextRequest, { params }: { params: { id: string } }) {
  try {
    const session = await getServerAuthSession();
    if (!session?.user?.id) return jsonError('로그인이 필요합니다.', 401);
    const actor = await getActorScope(session);
    if (!actor?.organizationId) return jsonError('소속 기관을 확인할 수 없습니다.', 403);
    if (!UUID.test(params.id)) return jsonError('문서를 찾을 수 없습니다.', 404);

    const body = (await request.json().catch(() => ({}))) as { tags?: unknown };
    const normalized = normalizeDocumentTags(body.tags);
    if (!normalized.ok) return jsonError(normalized.message, 400);

    const { data: doc, error } = await supabaseAdmin
      .from('documents')
      .select('id, agent_id, department_id, organization_id, visibility')
      .eq('id', params.id)
      .eq('organization_id', actor.organizationId)
      .maybeSingle();
    if (error) return jsonError('문서를 불러오지 못했습니다.', 500);
    const access = doc ? await documentTagAccess(doc, actor) : 'hidden';
    if (access === 'hidden') return jsonError('문서를 찾을 수 없습니다.', 404);
    if (access === 'forbidden') return jsonError('이 문서의 태그를 고칠 권한이 없습니다.', 403);

    let vocabulary;
    try {
      vocabulary = await loadTagVocabulary(actor.organizationId);
    } catch {
      return jsonError('태그 분류표를 불러오지 못했습니다. 잠시 뒤 다시 저장해 주세요.', 500);
    }
    const fitted = applyVocabulary(normalized.tags, vocabulary);
    if (!fitted.ok) return NextResponse.json({ ok: false, error: { message: fitted.message, code: 'outside_vocabulary', outside: fitted.outside } }, { status: 400 });

    const { data: updated, error: updateError } = await supabaseAdmin
      .from('documents')
      .update({ tags: fitted.tags })
      .eq('id', doc!.id)
      .eq('organization_id', actor.organizationId)
      .select('id, tags')
      .single();
    if (updateError) return jsonError('태그를 저장하지 못했습니다.', 500);
    return NextResponse.json({ ok: true, data: updated });
  } catch (error) {
    console.error('[documents tags]', error);
    return jsonError('태그를 저장하지 못했습니다.', 500);
  }
}
