import { NextRequest, NextResponse } from 'next/server';
import { getServerAuthSession, isAdminSession } from '@/lib/auth';
import { supabaseAdmin } from '@/lib/supabaseAdmin';
import { getActorScope } from '@/lib/actor-scope';
import { findManagedForbiddenWord } from '@/lib/forbidden-words-scope';

/**
 * 금지어 켜고 끄기·지우기 — 관리 범위(자기 부서 + 하위, 최상위 부서 관리자는 기관 전체) 안의 금지어만.
 * 금지어는 관리자가 정하는 보안 통제다. 직원이 끄거나 지울 수 있으면 통제 자체가 무의미해진다.
 * (2026-11-12) 예전에는 관리자 자기 부서의 금지어만 찾아(anon 키로) 하위 부서 금지어를 고칠 수 없었다.
 * 범위 밖이면 있는지 알리지 않고 404.
 */

const NOT_FOUND = () => NextResponse.json({ ok: false, error: { message: '금지어를 찾을 수 없습니다.' } }, { status: 404 });
const NO_DEPARTMENT = () => NextResponse.json({ ok: false, error: { message: '부서 정보를 찾을 수 없습니다.' } }, { status: 403 });
const LOOKUP_FAILED = () => NextResponse.json({ ok: false, error: { message: '금지어를 확인하지 못했습니다.' } }, { status: 500 });

export async function PATCH(request: NextRequest, { params }: { params: { id: string } }) {
  try {
    const session = await getServerAuthSession();
    if (!session?.user?.id) {
      return NextResponse.json({ ok: false, error: { message: '인증이 필요합니다.' } }, { status: 401 });
    }
    if (!isAdminSession(session)) {
      return NextResponse.json({ ok: false, error: { message: '관리자 권한이 필요합니다.' } }, { status: 403 });
    }
    const actor = await getActorScope(session);
    if (!actor || !actor.organizationId) return NO_DEPARTMENT();

    const body = await request.json().catch(() => null);
    const isActive = body && typeof body === 'object' ? (body as { is_active?: unknown }).is_active : undefined;
    if (typeof isActive !== 'boolean') {
      return NextResponse.json({ ok: false, error: { message: 'is_active 값은 필수입니다.' } }, { status: 400 });
    }

    const found = await findManagedForbiddenWord(params.id, actor.managedDepartmentIds);
    if (found === 'error') return LOOKUP_FAILED();
    if (!found) return NOT_FOUND();

    const { data: updatedWord, error: updateError } = await supabaseAdmin
      .from('forbidden_words')
      .update({ is_active: isActive, updated_at: new Date().toISOString() })
      .eq('id', found.id)
      .eq('department_id', found.department_id)
      .select()
      .single();
    if (updateError) {
      return NextResponse.json({ ok: false, error: { message: '금지어 업데이트 중 오류가 발생했습니다.' } }, { status: 500 });
    }

    await supabaseAdmin.from('usage_logs').insert({
      department_id: actor.departmentId,
      user_id: actor.userId,
      action: isActive ? 'activate_forbidden_word' : 'deactivate_forbidden_word',
      resource_type: 'forbidden_word',
      resource_id: found.id,
      details: { word: found.word, is_active: isActive, word_department_id: found.department_id },
    });

    return NextResponse.json({ ok: true, data: updatedWord });
  } catch (error) {
    console.error('금지어 업데이트 오류:', error);
    return NextResponse.json({ ok: false, error: { message: '서버 오류가 발생했습니다.' } }, { status: 500 });
  }
}

export async function DELETE(_request: NextRequest, { params }: { params: { id: string } }) {
  try {
    const session = await getServerAuthSession();
    if (!session?.user?.id) {
      return NextResponse.json({ ok: false, error: { message: '인증이 필요합니다.' } }, { status: 401 });
    }
    if (!isAdminSession(session)) {
      return NextResponse.json({ ok: false, error: { message: '관리자 권한이 필요합니다.' } }, { status: 403 });
    }
    const actor = await getActorScope(session);
    if (!actor || !actor.organizationId) return NO_DEPARTMENT();

    const found = await findManagedForbiddenWord(params.id, actor.managedDepartmentIds);
    if (found === 'error') return LOOKUP_FAILED();
    if (!found) return NOT_FOUND();

    const { error: deleteError } = await supabaseAdmin
      .from('forbidden_words')
      .delete()
      .eq('id', found.id)
      .eq('department_id', found.department_id);
    if (deleteError) {
      return NextResponse.json({ ok: false, error: { message: '금지어 삭제 중 오류가 발생했습니다.' } }, { status: 500 });
    }

    await supabaseAdmin.from('usage_logs').insert({
      department_id: actor.departmentId,
      user_id: actor.userId,
      action: 'delete_forbidden_word',
      resource_type: 'forbidden_word',
      resource_id: found.id,
      details: { word: found.word, word_department_id: found.department_id },
    });

    return NextResponse.json({ ok: true });
  } catch (error) {
    console.error('금지어 삭제 오류:', error);
    return NextResponse.json({ ok: false, error: { message: '서버 오류가 발생했습니다.' } }, { status: 500 });
  }
}
