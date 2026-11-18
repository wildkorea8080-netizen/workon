import { NextRequest, NextResponse } from 'next/server';
import { supabaseAdmin } from '@/lib/supabaseAdmin';
import { logSystem } from '@/lib/logger';
import { requireAdminOrg, cleanCategoryName, isCategoryId } from '@/lib/agent-category-admin';

export const dynamic = 'force-dynamic';

/**
 * 카테고리 이름 변경 / 삭제 — 기관 전체 관리자만(`requireAdminOrg('edit')`).
 *
 * `agents.category`가 FK가 아니라 이름(text)이라, 이름을 바꾸면 그 이름을
 * 쓰던 비서를 함께 갱신해야 한다. 안 하면 비서들이 없어진 이름을 가리키며
 * 미분류로 떨어진다.
 *
 * 2026-11-18: 비서를 옮기지 못하면 **카테고리 이름을 되돌린다.** 예전에는 이름만 바뀐 채 "다시 시도해주세요"라고 답했는데,
 * 다시 보내면 이름이 이미 같아 아무 일도 하지 않고 성공으로 답했다 — 비서들은 옛 이름을 가리킨 채 미분류로 남았다.
 * 대상 카테고리를 못 읽은 것도 '없음'(404)으로 보지 않는다(503).
 */

const fail = (message: string, status: number) =>
  NextResponse.json({ ok: false, error: { message } }, { status });

type Category = { id: string; name: string; display_order: number };

/** 대상 카테고리가 내 기관 것인지 확인하고 가져온다 — 못 읽었으면 `failed` */
async function loadCategory(
  id: string,
  organizationId: string,
): Promise<{ category: Category | null; failed: boolean }> {
  if (!isCategoryId(id)) return { category: null, failed: false };
  const { data, error } = await supabaseAdmin
    .from('agent_categories')
    .select('id, name, display_order')
    .eq('id', id)
    .eq('organization_id', organizationId)
    .maybeSingle();
  if (error) {
    console.error('[agent-categories] 카테고리 조회 실패', error);
    return { category: null, failed: true };
  }
  return { category: (data as Category | null) ?? null, failed: false };
}

export async function PATCH(request: NextRequest, { params }: { params: { id: string } }) {
  const ctx = await requireAdminOrg('edit');
  if ('error' in ctx) return ctx.error;

  try {
    const loaded = await loadCategory(params.id, ctx.organizationId);
    if (loaded.failed) return fail('카테고리를 확인하지 못했습니다. 잠시 뒤 다시 시도해 주세요.', 503);
    const category = loaded.category;
    if (!category) return fail('카테고리를 찾을 수 없습니다.', 404);

    let body: { name?: unknown };
    try {
      body = await request.json();
    } catch {
      return fail('요청 형식이 올바르지 않습니다.', 400);
    }

    const cleaned = cleanCategoryName(body?.name);
    if (!cleaned.ok) return fail(cleaned.message, 400);
    const name = cleaned.name;

    if (name === category.name) {
      return NextResponse.json({ ok: true, data: category });
    }

    const { data: updatedRows, error } = await supabaseAdmin
      .from('agent_categories')
      .update({ name })
      .eq('id', category.id)
      .eq('organization_id', ctx.organizationId)
      .select('id, name, display_order');

    if (error) {
      if (error.code === '23505') return fail('같은 이름의 카테고리가 이미 있습니다.', 409);
      console.error('[agent-categories PATCH]', error);
      return fail('이름 변경에 실패했습니다.', 500);
    }
    const updated = ((updatedRows ?? []) as Category[])[0];
    if (!updated) return fail('카테고리를 찾을 수 없습니다.', 404);

    // 이름을 쓰던 비서를 함께 옮긴다. 이걸 빠뜨리면 비서들이 없어진 이름을 가리키며 미분류로 떨어진다.
    // 카테고리 표를 먼저 바꾸는 것은 같은 이름 검사(유일 색인)를 먼저 받으려는 것 — 비서를 먼저 옮기면 겹친 이름의 다른 카테고리에 섞인다.
    const { error: moveError } = await supabaseAdmin
      .from('agents')
      .update({ category: name })
      .eq('organization_id', ctx.organizationId)
      .eq('category', category.name);

    if (moveError) {
      console.error('[agent-categories PATCH] 비서 이동 실패', moveError);

      // 이름을 되돌려 '카테고리는 새 이름·비서는 옛 이름'인 상태를 남기지 않는다(그래야 다시 시도가 통한다)
      const { error: revertError } = await supabaseAdmin
        .from('agent_categories')
        .update({ name: category.name })
        .eq('id', category.id)
        .eq('organization_id', ctx.organizationId)
        .eq('name', name);

      if (revertError) {
        await logSystem({
          level: 'error',
          category: 'database',
          message: '비서 카테고리 이름만 바뀌고 소속 비서는 옮기지 못했습니다(되돌리기도 실패)',
          details: { category_id: category.id, move_code: moveError.code ?? 'error', revert_code: revertError.code ?? 'error' },
          orgId: ctx.organizationId,
        });
        return fail(
          '카테고리 이름은 바뀌었지만 소속 비서를 옮기지 못했습니다. 이름을 원래대로 바꾼 뒤 다시 시도해 주세요.',
          500,
        );
      }

      return fail('소속 비서를 옮기지 못해 이름을 바꾸지 않았습니다. 잠시 뒤 다시 시도해 주세요.', 500);
    }

    return NextResponse.json({ ok: true, data: updated });
  } catch (err) {
    console.error('[agent-categories PATCH] 오류', err);
    return fail('이름 변경에 실패했습니다.', 500);
  }
}

export async function DELETE(_request: NextRequest, { params }: { params: { id: string } }) {
  const ctx = await requireAdminOrg('edit');
  if ('error' in ctx) return ctx.error;

  try {
    const loaded = await loadCategory(params.id, ctx.organizationId);
    if (loaded.failed) return fail('카테고리를 확인하지 못했습니다. 잠시 뒤 다시 시도해 주세요.', 503);
    const category = loaded.category;
    if (!category) return fail('카테고리를 찾을 수 없습니다.', 404);

    // 비서는 지우지 않는다. 카테고리만 떼어 미분류로 보낸다.
    // 분류를 정리하려다 비서가 사라지면 되돌릴 방법이 없다.
    const { error: detachError } = await supabaseAdmin
      .from('agents')
      .update({ category: null })
      .eq('organization_id', ctx.organizationId)
      .eq('category', category.name);

    if (detachError) {
      console.error('[agent-categories DELETE] 비서 분리 실패', detachError);
      return fail('소속 비서를 정리하지 못해 삭제를 중단했습니다.', 500);
    }

    const { error } = await supabaseAdmin
      .from('agent_categories')
      .delete()
      .eq('id', category.id)
      .eq('organization_id', ctx.organizationId);

    if (error) {
      console.error('[agent-categories DELETE]', error);
      return fail('카테고리 삭제에 실패했습니다. 다시 삭제해 주세요.', 500);
    }

    return NextResponse.json({ ok: true, data: { id: category.id } });
  } catch (err) {
    console.error('[agent-categories DELETE] 오류', err);
    return fail('카테고리 삭제에 실패했습니다.', 500);
  }
}
