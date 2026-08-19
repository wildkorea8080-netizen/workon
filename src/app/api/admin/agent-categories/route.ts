import { NextRequest, NextResponse } from 'next/server';
import { getServerAuthSession, isAdminSession } from '@/lib/auth';
import { supabaseAdmin } from '@/lib/supabaseAdmin';

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
 */

const MAX_NAME_LENGTH = 30;

/** 관리자 세션에서 기관 id를 얻는다. 모든 작업을 이 기관으로 한정한다. */
async function requireAdminOrg() {
  const session = await getServerAuthSession();
  if (!session?.user?.id || !isAdminSession(session)) {
    return {
      error: NextResponse.json(
        { ok: false, error: { message: '관리자 권한이 필요합니다.' } },
        { status: 403 }
      ),
    };
  }

  const departmentId = session.user.departmentId;
  if (!departmentId) {
    return {
      error: NextResponse.json(
        { ok: false, error: { message: '부서 정보를 찾을 수 없습니다.' } },
        { status: 403 }
      ),
    };
  }

  const { data } = await supabaseAdmin
    .from('departments')
    .select('organization_id')
    .eq('id', departmentId)
    .maybeSingle();

  const organizationId = data?.organization_id;
  if (!organizationId) {
    return {
      error: NextResponse.json(
        { ok: false, error: { message: '기관 정보를 찾을 수 없습니다.' } },
        { status: 409 }
      ),
    };
  }

  return { session, departmentId, organizationId };
}

/** 목록 — 각 카테고리에 묶인 비서 수를 함께 준다(삭제 영향 확인용) */
export async function GET() {
  const ctx = await requireAdminOrg();
  if ('error' in ctx) return ctx.error;

  const { data: categories, error } = await supabaseAdmin
    .from('agent_categories')
    .select('id, name, display_order')
    .eq('organization_id', ctx.organizationId)
    .order('display_order', { ascending: true })
    .order('name', { ascending: true });

  if (error) {
    console.error('[agent-categories GET]', error);
    return NextResponse.json(
      { ok: false, error: { message: '카테고리 조회에 실패했습니다.' } },
      { status: 500 }
    );
  }

  const { data: agents } = await supabaseAdmin
    .from('agents')
    .select('category')
    .eq('organization_id', ctx.organizationId);

  const counts = new Map<string, number>();
  for (const row of (agents ?? []) as { category: string | null }[]) {
    const key = row.category?.trim();
    if (key) counts.set(key, (counts.get(key) ?? 0) + 1);
  }

  return NextResponse.json({
    ok: true,
    data: (categories ?? []).map((c: { id: string; name: string; display_order: number }) => ({
      ...c,
      agent_count: counts.get(c.name) ?? 0,
    })),
  });
}

/** 추가 */
export async function POST(request: NextRequest) {
  const ctx = await requireAdminOrg();
  if ('error' in ctx) return ctx.error;

  const body = await request.json();
  const name = typeof body.name === 'string' ? body.name.trim() : '';

  if (!name) {
    return NextResponse.json(
      { ok: false, error: { message: '카테고리 이름을 입력해주세요.' } },
      { status: 400 }
    );
  }
  if (name.length > MAX_NAME_LENGTH) {
    return NextResponse.json(
      { ok: false, error: { message: `카테고리는 ${MAX_NAME_LENGTH}자 이내로 입력해주세요.` } },
      { status: 400 }
    );
  }

  // 새 카테고리는 맨 뒤에 붙인다. 기존 순서를 흔들지 않는다.
  const { data: last } = await supabaseAdmin
    .from('agent_categories')
    .select('display_order')
    .eq('organization_id', ctx.organizationId)
    .order('display_order', { ascending: false })
    .limit(1)
    .maybeSingle();

  const { data: created, error } = await supabaseAdmin
    .from('agent_categories')
    .insert({
      organization_id: ctx.organizationId,
      name,
      display_order: (last?.display_order ?? -1) + 1,
    })
    .select('id, name, display_order')
    .single();

  if (error) {
    if (error.code === '23505') {
      return NextResponse.json(
        { ok: false, error: { message: '같은 이름의 카테고리가 이미 있습니다.' } },
        { status: 409 }
      );
    }
    console.error('[agent-categories POST]', error);
    return NextResponse.json(
      { ok: false, error: { message: '카테고리 추가에 실패했습니다.' } },
      { status: 500 }
    );
  }

  return NextResponse.json({ ok: true, data: { ...created, agent_count: 0 } }, { status: 201 });
}

/** 순서 일괄 저장 — 드래그 후 한 번에 보낸다 */
export async function PUT(request: NextRequest) {
  const ctx = await requireAdminOrg();
  if ('error' in ctx) return ctx.error;

  const body = await request.json();
  const order: unknown = body.order;

  if (!Array.isArray(order) || order.some((id) => typeof id !== 'string')) {
    return NextResponse.json(
      { ok: false, error: { message: '순서 정보가 올바르지 않습니다.' } },
      { status: 400 }
    );
  }

  // 내 기관 것만 대상으로 한다. 남의 기관 id가 섞여 와도 그건 갱신되지 않는다.
  const { data: mine } = await supabaseAdmin
    .from('agent_categories')
    .select('id')
    .eq('organization_id', ctx.organizationId);

  const allowed = new Set((mine ?? []).map((c: { id: string }) => c.id));

  let position = 0;
  for (const id of order as string[]) {
    if (!allowed.has(id)) continue;
    const { error } = await supabaseAdmin
      .from('agent_categories')
      .update({ display_order: position })
      .eq('id', id)
      .eq('organization_id', ctx.organizationId);

    if (error) {
      console.error('[agent-categories PUT]', error);
      return NextResponse.json(
        { ok: false, error: { message: '순서 저장에 실패했습니다.' } },
        { status: 500 }
      );
    }
    position += 1;
  }

  return NextResponse.json({ ok: true, data: { updated: position } });
}
