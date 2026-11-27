import { NextRequest, NextResponse } from 'next/server';
import { supabaseAdmin } from '@/lib/supabaseAdmin';
import { pagedRows } from '@/lib/paged-select';
import { requireAdminOrg, cleanCategoryName, isCategoryId } from '@/lib/agent-category-admin';

export const dynamic = 'force-dynamic';

/**
 * 비서 카테고리 관리 (0019).
 *
 * 카테고리는 **표시 분류일 뿐 권한이 아니다.** 누가 볼 수 있는지는
 * `agents.visibility`가 정한다. 카테고리에 권한을 얹으면 "카테고리는
 * 공개인데 비서는 비공개" 같은 모순 상태가 생기고 어느 쪽이 이기는지를
 * 매번 판단해야 한다.
 *
 * `agents.category`는 FK가 아니라 이름(text)이다. 그래서 카테고리를
 * 지워도 비서는 사라지지 않고 미분류로 떨어지며, 이름을 바꾸면 그 이름을
 * 쓰던 비서를 함께 갱신해야 한다(PATCH 참조).
 *
 * 2026-11-18: 목록은 관리자 누구나, **바꾸기는 기관 전체 관리자만**(`requireAdminOrg('edit')`). 읽기 실패를 '없음'·0으로 쓰지 않는다 —
 * 순서 저장이 내 기관 카테고리를 못 읽으면 아무것도 안 바꾸고 성공으로 답했고, 비서 수를 못 읽으면 0개로 보여 삭제 확인 문구가 틀렸다.
 */

const MAX_ORDER_IDS = 500;

const fail = (message: string, status: number) =>
  NextResponse.json({ ok: false, error: { message } }, { status });

/**
 * 카테고리 이름 → 묶인 비서 수. 지운 비서와 나만의 비서는 세지 않는다(관리 화면·직원 목록에 보이는 비서만).
 * 못 읽었거나 다 읽지 못했으면 null — 0으로 보이면 '삭제해도 영향 없음'으로 읽힌다.
 */
async function countAgentsByCategory(organizationId: string): Promise<Map<string, number> | null> {
  const read = await pagedRows<{ category: string | null }>((from, to, withCount) =>
    supabaseAdmin
      .from('agents')
      .select('category', withCount ? { count: 'exact' } : undefined)
      .eq('organization_id', organizationId)
      .is('deleted_at', null)
      .neq('tier', 'personal')
      .neq('tier', 'public')
      .not('category', 'is', null)
      .order('id', { ascending: true })
      .range(from, to),
  );
  if (read.error || read.truncated) {
    if (read.error) console.error('[agent-categories GET] 비서 수 조회 실패', read.error);
    return null;
  }
  const counts = new Map<string, number>();
  for (const row of read.data) {
    const key = row.category?.trim();
    if (key) counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return counts;
}

/** 목록 — 각 카테고리에 묶인 비서 수를 함께 준다(삭제 영향 확인용). `canEdit`은 바꿀 수 있는 사람인지 */
export async function GET() {
  const ctx = await requireAdminOrg('read');
  if ('error' in ctx) return ctx.error;

  try {
    const { data: categories, error } = await supabaseAdmin
      .from('agent_categories')
      .select('id, name, display_order')
      .eq('organization_id', ctx.organizationId)
      .order('display_order', { ascending: true })
      .order('name', { ascending: true });

    if (error) {
      console.error('[agent-categories GET]', error);
      return fail('카테고리 조회에 실패했습니다.', 500);
    }

    const counts = await countAgentsByCategory(ctx.organizationId);

    return NextResponse.json({
      ok: true,
      data: (categories ?? []).map((c: { id: string; name: string; display_order: number }) => ({
        ...c,
        agent_count: counts ? counts.get(c.name) ?? 0 : null,
      })),
      canEdit: ctx.canEdit,
    });
  } catch (err) {
    console.error('[agent-categories GET] 오류', err);
    return fail('카테고리 조회에 실패했습니다.', 500);
  }
}

/** 추가 */
export async function POST(request: NextRequest) {
  const ctx = await requireAdminOrg('edit');
  if ('error' in ctx) return ctx.error;

  try {
    let body: { name?: unknown };
    try {
      body = await request.json();
    } catch {
      return fail('요청 형식이 올바르지 않습니다.', 400);
    }

    const cleaned = cleanCategoryName(body?.name);
    if (!cleaned.ok) return fail(cleaned.message, 400);

    // 새 카테고리는 맨 뒤에 붙인다. 기존 순서를 흔들지 않는다 — 마지막 순서를 못 읽으면 맨 앞(0)에 끼우지 않고 멈춘다
    const { data: last, error: lastError } = await supabaseAdmin
      .from('agent_categories')
      .select('display_order')
      .eq('organization_id', ctx.organizationId)
      .order('display_order', { ascending: false })
      .limit(1);

    if (lastError) {
      console.error('[agent-categories POST] 순서 조회 실패', lastError);
      return fail('카테고리 추가에 실패했습니다. 잠시 뒤 다시 시도해 주세요.', 500);
    }
    const lastOrder = ((last ?? []) as Array<{ display_order: number | null }>)[0]?.display_order;

    const { data: created, error } = await supabaseAdmin
      .from('agent_categories')
      .insert({
        organization_id: ctx.organizationId,
        name: cleaned.name,
        display_order: (lastOrder ?? -1) + 1,
      })
      .select('id, name, display_order')
      .single();

    if (error || !created) {
      if (error?.code === '23505') return fail('같은 이름의 카테고리가 이미 있습니다.', 409);
      console.error('[agent-categories POST]', error);
      return fail('카테고리 추가에 실패했습니다.', 500);
    }

    return NextResponse.json({ ok: true, data: { ...created, agent_count: 0 } }, { status: 201 });
  } catch (err) {
    console.error('[agent-categories POST] 오류', err);
    return fail('카테고리 추가에 실패했습니다.', 500);
  }
}

/** 순서 일괄 저장 — 위/아래로 옮긴 뒤 한 번에 보낸다 */
export async function PUT(request: NextRequest) {
  const ctx = await requireAdminOrg('edit');
  if ('error' in ctx) return ctx.error;

  try {
    let body: { order?: unknown };
    try {
      body = await request.json();
    } catch {
      return fail('요청 형식이 올바르지 않습니다.', 400);
    }
    const order: unknown = body?.order;

    if (!Array.isArray(order) || order.length > MAX_ORDER_IDS || order.some((id) => !isCategoryId(id))) {
      return fail('순서 정보가 올바르지 않습니다.', 400);
    }
    // 같은 id가 두 번 오면 처음 자리만 쓴다
    const ids = [...new Set(order as string[])];

    // 내 기관 것만 대상으로 한다. 남의 기관 id가 섞여 와도 그건 갱신되지 않는다.
    // 못 읽은 것을 '내 것이 없음'으로 보면 아무것도 안 바꾸고 성공으로 답한다 — 실패로 알린다
    const { data: mine, error: mineError } = await supabaseAdmin
      .from('agent_categories')
      .select('id')
      .eq('organization_id', ctx.organizationId);

    if (mineError) {
      console.error('[agent-categories PUT] 카테고리 조회 실패', mineError);
      return fail('순서 저장에 실패했습니다. 잠시 뒤 다시 시도해 주세요.', 500);
    }

    const allowed = new Set(((mine ?? []) as Array<{ id: string }>).map((c) => c.id));
    const targets = ids.filter((id) => allowed.has(id));
    if (ids.length > 0 && targets.length === 0) {
      return fail('순서를 바꿀 카테고리를 찾을 수 없습니다. 목록을 새로 고친 뒤 다시 해 주세요.', 404);
    }

    let position = 0;
    for (const id of targets) {
      const { error } = await supabaseAdmin
        .from('agent_categories')
        .update({ display_order: position })
        .eq('id', id)
        .eq('organization_id', ctx.organizationId);

      if (error) {
        console.error('[agent-categories PUT]', error);
        return fail('순서 저장에 실패했습니다.', 500);
      }
      position += 1;
    }

    return NextResponse.json({ ok: true, data: { updated: position } });
  } catch (err) {
    console.error('[agent-categories PUT] 오류', err);
    return fail('순서 저장에 실패했습니다.', 500);
  }
}
