import { NextRequest, NextResponse } from 'next/server';
import { getServerAuthSession, isAdminSession } from '@/lib/auth';
import { getActorScope } from '@/lib/actor-scope';
import { supabaseAdmin } from '@/lib/supabaseAdmin';
import { normalizeVocabulary } from '@/lib/document-tags';
import { loadTagVocabulary } from '@/lib/document-tag-vocabulary';

export const dynamic = 'force-dynamic';

/**
 * 기관 태그 분류표(0061).
 * - GET: 같은 기관 사람 누구나(태그를 붙일 때 분류표 표기를 고르려고) — `{ tags, restricted, updatedAt, canEdit }`
 * - PUT `{ tags, restricted, baseUpdatedAt }`: 기관 전체 관리자만. 다른 관리자가 그 사이 고쳤으면 409(`code: 'conflict'`).
 *   이미 붙은 문서 태그는 바꾸지 않는다(켠 뒤 그 문서를 저장할 때 분류표에 맞춰야 한다)
 */

function jsonError(message: string, status: number, code?: string) {
  return NextResponse.json({ ok: false, error: { message, ...(code ? { code } : {}) } }, { status });
}

const CONFLICT = '다른 관리자가 먼저 분류표를 고쳤습니다. 다시 불러온 뒤 고쳐 주세요.';

export async function GET() {
  try {
    const session = await getServerAuthSession();
    if (!session?.user?.id) return jsonError('로그인이 필요합니다.', 401);
    const actor = await getActorScope(session);
    if (!actor?.organizationId) return jsonError('소속 기관을 확인할 수 없습니다.', 403);
    const vocabulary = await loadTagVocabulary(actor.organizationId);
    return NextResponse.json({ ok: true, data: { ...vocabulary, canEdit: actor.isAdmin && actor.managesWholeOrganization } });
  } catch (error) {
    console.error('[tag-vocabulary GET]', error instanceof Error ? error.message : error);
    return jsonError('태그 분류표를 불러오지 못했습니다.', 500);
  }
}

export async function PUT(request: NextRequest) {
  try {
    const session = await getServerAuthSession();
    if (!isAdminSession(session)) return jsonError('관리자 권한이 필요합니다.', 403);
    const actor = await getActorScope(session!);
    if (!actor?.organizationId) return jsonError('소속 기관을 확인할 수 없습니다.', 403);
    if (!actor.managesWholeOrganization) return jsonError('태그 분류표는 기관 전체 관리자만 고칠 수 있습니다.', 403);

    const body = (await request.json().catch(() => ({}))) as { tags?: unknown; restricted?: unknown; baseUpdatedAt?: unknown };
    const normalized = normalizeVocabulary(body.tags, body.restricted);
    if (!normalized.ok) return jsonError(normalized.message, 400);
    const base = typeof body.baseUpdatedAt === 'string' ? body.baseUpdatedAt : null;
    if (body.baseUpdatedAt !== undefined && body.baseUpdatedAt !== null && base === null) return jsonError('기준 시각을 확인해 주세요.', 400);

    const current = await loadTagVocabulary(actor.organizationId);
    const now = new Date().toISOString();
    const values = { tags: normalized.vocabulary.tags, restricted: normalized.vocabulary.restricted, updated_by: actor.userId, updated_at: now };

    if (current.updatedAt === null) {
      // 아직 행이 없다 — 기준이 있으면(그 사이 누가 지웠다) 충돌, 동시에 처음 저장하면 기본 키가 막는다
      if (base !== null) return jsonError(CONFLICT, 409, 'conflict');
      const { data, error } = await supabaseAdmin
        .from('document_tag_vocabularies')
        .insert({ organization_id: actor.organizationId, ...values })
        .select('tags, restricted, updated_at')
        .single();
      if (error?.code === '23505') return jsonError(CONFLICT, 409, 'conflict');
      if (error) return jsonError('태그 분류표를 저장하지 못했습니다.', 500);
      return NextResponse.json({ ok: true, data: { tags: data.tags, restricted: data.restricted, updatedAt: data.updated_at, canEdit: true } });
    }

    if (base === null || base !== current.updatedAt) return jsonError(CONFLICT, 409, 'conflict');
    // 조건부 — 읽은 뒤 그 사이 다른 저장이 끼면 맞는 행이 없어 충돌로 본다
    const { data, error } = await supabaseAdmin
      .from('document_tag_vocabularies')
      .update(values)
      .eq('organization_id', actor.organizationId)
      .eq('updated_at', current.updatedAt)
      .select('tags, restricted, updated_at')
      .maybeSingle();
    if (error) return jsonError('태그 분류표를 저장하지 못했습니다.', 500);
    if (!data) return jsonError(CONFLICT, 409, 'conflict');
    return NextResponse.json({ ok: true, data: { tags: data.tags, restricted: data.restricted, updatedAt: data.updated_at, canEdit: true } });
  } catch (error) {
    console.error('[tag-vocabulary PUT]', error instanceof Error ? error.message : error);
    return jsonError('태그 분류표를 저장하지 못했습니다.', 500);
  }
}
