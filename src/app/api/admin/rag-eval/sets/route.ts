import { NextRequest, NextResponse } from 'next/server';
import { getServerAuthSession, isAdminSession } from '@/lib/auth';
import { supabaseAdmin } from '@/lib/supabaseAdmin';
import { getActorScope } from '@/lib/actor-scope';
import { canChangeRagEvalSet, prepareRagEvalSet, RAG_EVAL_SETS_MAX, type RagEvalSetRow } from '@/lib/rag-eval-sets';

/**
 * 문서 찾기 일괄 평가의 이름 붙인 세트(0059) — 기관 관리자만. 세트는 기관 단위다(비서에 묶지 않음).
 * - GET: 기관의 세트 목록(이름·질문 수·고친 때). `?id=`: 세트 하나(세트 글 포함)
 * - POST `{ name, set, overwrite? }`: 저장. 같은 이름이 있으면 409(`code: 'exists'`), `overwrite: true`면 덮어쓴다
 *   (만든 사람이나 기관 전체 관리자만)
 * - DELETE `?id=`: 지우기(만든 사람이나 기관 전체 관리자만)
 */

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const LIST_COLUMNS = 'id, name, question_count, created_by, updated_at';

function jsonError(message: string, status: number, code?: string) {
  return NextResponse.json({ ok: false, error: { message, ...(code ? { code } : {}) } }, { status });
}

export async function GET(request: NextRequest) {
  try {
    const session = await getServerAuthSession();
    if (!isAdminSession(session)) return jsonError('관리자 권한이 필요합니다.', 403);
    const actor = await getActorScope(session!);
    if (!actor?.organizationId) return jsonError('소속 부서가 지정되지 않았습니다.', 403);

    const id = request.nextUrl.searchParams.get('id');
    if (id) {
      if (!UUID.test(id)) return jsonError('세트를 찾을 수 없습니다.', 404);
      const { data, error } = await supabaseAdmin
        .from('rag_eval_sets')
        .select(`${LIST_COLUMNS}, set_text`)
        .eq('id', id)
        .eq('organization_id', actor.organizationId)
        .maybeSingle();
      if (error) return jsonError('세트를 불러오지 못했습니다.', 500);
      if (!data) return jsonError('세트를 찾을 수 없습니다.', 404);
      return NextResponse.json({ ok: true, data });
    }
    const { data, error } = await supabaseAdmin
      .from('rag_eval_sets')
      .select(LIST_COLUMNS)
      .eq('organization_id', actor.organizationId)
      .order('updated_at', { ascending: false })
      .limit(RAG_EVAL_SETS_MAX);
    if (error) return jsonError('세트 목록을 불러오지 못했습니다.', 500);
    return NextResponse.json({ ok: true, data: data ?? [] });
  } catch (error) {
    console.error('[rag-eval sets GET]', error);
    return jsonError('세트 목록을 불러오지 못했습니다.', 500);
  }
}

export async function POST(request: NextRequest) {
  try {
    const session = await getServerAuthSession();
    if (!isAdminSession(session)) return jsonError('관리자 권한이 필요합니다.', 403);
    const actor = await getActorScope(session!);
    if (!actor?.organizationId) return jsonError('소속 부서가 지정되지 않았습니다.', 403);

    const body = (await request.json().catch(() => ({}))) as { name?: unknown; set?: unknown; overwrite?: unknown };
    const prepared = prepareRagEvalSet(body);
    if (!prepared.ok) return jsonError(prepared.message, 400);

    const { data: existing, error: findError } = await supabaseAdmin
      .from('rag_eval_sets')
      .select(LIST_COLUMNS)
      .eq('organization_id', actor.organizationId)
      .eq('name', prepared.name)
      .maybeSingle();
    if (findError) return jsonError('세트를 저장하지 못했습니다.', 500);

    const now = new Date().toISOString();
    if (existing) {
      if (body.overwrite !== true) return jsonError(`같은 이름의 세트(${prepared.name})가 있습니다. 덮어쓸까요?`, 409, 'exists');
      if (!canChangeRagEvalSet(existing as RagEvalSetRow, actor)) return jsonError('이 세트는 만든 사람이나 기관 전체 관리자만 고칠 수 있습니다.', 403);
      const { data, error } = await supabaseAdmin
        .from('rag_eval_sets')
        .update({ set_text: prepared.text, question_count: prepared.count, updated_by: actor.userId, updated_at: now })
        .eq('id', (existing as RagEvalSetRow).id)
        .eq('organization_id', actor.organizationId)
        .select(LIST_COLUMNS)
        .single();
      if (error) return jsonError('세트를 저장하지 못했습니다.', 500);
      return NextResponse.json({ ok: true, data });
    }

    const { count, error: countError } = await supabaseAdmin
      .from('rag_eval_sets')
      .select('id', { count: 'exact', head: true })
      .eq('organization_id', actor.organizationId);
    if (countError) return jsonError('세트를 저장하지 못했습니다.', 500);
    if ((count ?? 0) >= RAG_EVAL_SETS_MAX) {
      return jsonError(`세트는 기관에 ${RAG_EVAL_SETS_MAX}개까지 보관합니다. 쓰지 않는 세트를 지운 뒤 저장해 주세요.`, 409, 'limit');
    }

    const { data, error } = await supabaseAdmin
      .from('rag_eval_sets')
      .insert({
        organization_id: actor.organizationId, name: prepared.name, set_text: prepared.text, question_count: prepared.count,
        created_by: actor.userId, updated_by: actor.userId, created_at: now, updated_at: now,
      })
      .select(LIST_COLUMNS)
      .single();
    // 같은 이름을 동시에 저장하면 유일 색인이 막는다 — 덮어쓸지 다시 묻는다
    if (error?.code === '23505') return jsonError(`같은 이름의 세트(${prepared.name})가 있습니다. 덮어쓸까요?`, 409, 'exists');
    if (error) return jsonError('세트를 저장하지 못했습니다.', 500);
    return NextResponse.json({ ok: true, data });
  } catch (error) {
    console.error('[rag-eval sets POST]', error);
    return jsonError('세트를 저장하지 못했습니다.', 500);
  }
}

export async function DELETE(request: NextRequest) {
  try {
    const session = await getServerAuthSession();
    if (!isAdminSession(session)) return jsonError('관리자 권한이 필요합니다.', 403);
    const actor = await getActorScope(session!);
    if (!actor?.organizationId) return jsonError('소속 부서가 지정되지 않았습니다.', 403);

    const id = request.nextUrl.searchParams.get('id');
    if (!id || !UUID.test(id)) return jsonError('세트를 찾을 수 없습니다.', 404);
    const { data: row, error } = await supabaseAdmin
      .from('rag_eval_sets')
      .select(LIST_COLUMNS)
      .eq('id', id)
      .eq('organization_id', actor.organizationId)
      .maybeSingle();
    if (error) return jsonError('세트를 지우지 못했습니다.', 500);
    if (!row) return jsonError('세트를 찾을 수 없습니다.', 404);
    if (!canChangeRagEvalSet(row as RagEvalSetRow, actor)) return jsonError('이 세트는 만든 사람이나 기관 전체 관리자만 지울 수 있습니다.', 403);
    const { error: delError } = await supabaseAdmin.from('rag_eval_sets').delete().eq('id', id).eq('organization_id', actor.organizationId);
    if (delError) return jsonError('세트를 지우지 못했습니다.', 500);
    return NextResponse.json({ ok: true, data: { id } });
  } catch (error) {
    console.error('[rag-eval sets DELETE]', error);
    return jsonError('세트를 지우지 못했습니다.', 500);
  }
}
