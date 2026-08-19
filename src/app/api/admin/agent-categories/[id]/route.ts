import { NextRequest, NextResponse } from 'next/server';
import { getServerAuthSession, isAdminSession } from '@/lib/auth';
import { supabaseAdmin } from '@/lib/supabaseAdmin';

export const dynamic = 'force-dynamic';

/**
 * 카테고리 이름 변경 / 삭제.
 *
 * `agents.category`가 FK가 아니라 이름(text)이라, 이름을 바꾸면 그 이름을
 * 쓰던 비서를 함께 갱신해야 한다. 안 하면 비서들이 없어진 이름을 가리키며
 * 미분류로 떨어진다.
 */

const MAX_NAME_LENGTH = 30;

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

  return { organizationId };
}

/** 대상 카테고리가 내 기관 것인지 확인하고 가져온다 */
async function loadCategory(id: string, organizationId: string) {
  const { data } = await supabaseAdmin
    .from('agent_categories')
    .select('id, name, display_order')
    .eq('id', id)
    .eq('organization_id', organizationId)
    .maybeSingle();
  return data;
}

export async function PATCH(request: NextRequest, { params }: { params: { id: string } }) {
  const ctx = await requireAdminOrg();
  if ('error' in ctx) return ctx.error;

  const category = await loadCategory(params.id, ctx.organizationId);
  if (!category) {
    return NextResponse.json(
      { ok: false, error: { message: '카테고리를 찾을 수 없습니다.' } },
      { status: 404 }
    );
  }

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
  if (name === category.name) {
    return NextResponse.json({ ok: true, data: category });
  }

  const { data: updated, error } = await supabaseAdmin
    .from('agent_categories')
    .update({ name })
    .eq('id', category.id)
    .eq('organization_id', ctx.organizationId)
    .select('id, name, display_order')
    .single();

  if (error) {
    if (error.code === '23505') {
      return NextResponse.json(
        { ok: false, error: { message: '같은 이름의 카테고리가 이미 있습니다.' } },
        { status: 409 }
      );
    }
    console.error('[agent-categories PATCH]', error);
    return NextResponse.json(
      { ok: false, error: { message: '이름 변경에 실패했습니다.' } },
      { status: 500 }
    );
  }

  // 이름을 쓰던 비서를 함께 옮긴다. 이걸 빠뜨리면 비서들이 없어진 이름을
  // 가리키며 미분류로 떨어진다. 카테고리 표를 먼저 바꾼 뒤 실행하므로
  // 실패해도 카테고리는 남고 비서만 미분류가 된다 — 되돌릴 수 있는 상태다.
  const { error: moveError } = await supabaseAdmin
    .from('agents')
    .update({ category: name })
    .eq('organization_id', ctx.organizationId)
    .eq('category', category.name);

  if (moveError) {
    console.error('[agent-categories PATCH] 비서 이동 실패', moveError);
    return NextResponse.json(
      {
        ok: false,
        error: {
          message: '카테고리 이름은 바뀌었지만 소속 비서를 옮기지 못했습니다. 다시 시도해주세요.',
        },
      },
      { status: 500 }
    );
  }

  return NextResponse.json({ ok: true, data: updated });
}

export async function DELETE(_request: NextRequest, { params }: { params: { id: string } }) {
  const ctx = await requireAdminOrg();
  if ('error' in ctx) return ctx.error;

  const category = await loadCategory(params.id, ctx.organizationId);
  if (!category) {
    return NextResponse.json(
      { ok: false, error: { message: '카테고리를 찾을 수 없습니다.' } },
      { status: 404 }
    );
  }

  // 비서는 지우지 않는다. 카테고리만 떼어 미분류로 보낸다.
  // 분류를 정리하려다 비서가 사라지면 되돌릴 방법이 없다.
  const { error: detachError } = await supabaseAdmin
    .from('agents')
    .update({ category: null })
    .eq('organization_id', ctx.organizationId)
    .eq('category', category.name);

  if (detachError) {
    console.error('[agent-categories DELETE] 비서 분리 실패', detachError);
    return NextResponse.json(
      { ok: false, error: { message: '소속 비서를 정리하지 못해 삭제를 중단했습니다.' } },
      { status: 500 }
    );
  }

  const { error } = await supabaseAdmin
    .from('agent_categories')
    .delete()
    .eq('id', category.id)
    .eq('organization_id', ctx.organizationId);

  if (error) {
    console.error('[agent-categories DELETE]', error);
    return NextResponse.json(
      { ok: false, error: { message: '카테고리 삭제에 실패했습니다.' } },
      { status: 500 }
    );
  }

  return NextResponse.json({ ok: true, data: { id: category.id } });
}
