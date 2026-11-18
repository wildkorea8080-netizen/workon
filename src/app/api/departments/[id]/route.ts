import { NextRequest, NextResponse } from 'next/server';
import { getServerAuthSession, isAdminSession } from '@/lib/auth';
import { supabaseAdmin } from '@/lib/supabaseAdmin';
import { departmentDescendantsStrict, getManagedDepartmentIds } from '@/lib/department-scope';
import { checkDepartmentDelete, departmentDeleteMessage } from '@/lib/department-delete';
import { departmentChanges, departmentNameOf } from '@/lib/department-audit';
import { logSecurityEvent } from '@/lib/security-log';

export const dynamic = 'force-dynamic';

async function requireAdminOrg() {
  const session = await getServerAuthSession();
  if (!session?.user?.id || !isAdminSession(session)) {
    return { error: NextResponse.json({ ok: false, error: { message: '관리자 권한이 필요합니다.' } }, { status: 403 }) };
  }

  const departmentId = session.user.departmentId;
  if (!departmentId) {
    return { error: NextResponse.json({ ok: false, error: { message: '부서 정보를 찾을 수 없습니다.' } }, { status: 403 }) };
  }

  const { data, error: readError } = await supabaseAdmin
    .from('departments')
    .select('organization_id, parent_id')
    .eq('id', departmentId)
    .maybeSingle();
  if (readError) {
    return { error: NextResponse.json({ ok: false, error: { message: '부서 정보를 지금 읽지 못했습니다. 잠시 뒤 다시 시도해 주세요.' } }, { status: 503 }) };
  }

  const organizationId = data?.organization_id;
  if (!organizationId) {
    return { error: NextResponse.json({ ok: false, error: { message: '기관 정보를 찾을 수 없습니다.' } }, { status: 409 }) };
  }

  // 기관 직속(최상위) 부서의 관리자인지. 최상위로 올리는 이동을 여기서 가른다.
  const isRootAdmin = data.parent_id == null;

  return { session, departmentId, organizationId, isRootAdmin };
}

const READ_FAILED = { ok: false, error: { message: '부서 정보를 지금 읽지 못했습니다. 잠시 뒤 다시 시도해 주세요.' } };

type TargetDepartment = {
  id: string;
  name: string;
  parent_id: string | null;
  // 고치기 전 값 — 무엇이 달라졌는지 보안 로그에 남긴다
  monthly_budget_krw?: unknown;
  user_monthly_budget_krw?: unknown;
};

/**
 * 대상 부서가 관리자의 관리 범위(자기 부서 + 하위) 안인지 확인.
 * 못 읽은 것은 `'failed'` — '없음'(null)과 가른다(2026-11-18).
 */
async function loadDepartment(id: string, organizationId: string, managedIds: string[]): Promise<TargetDepartment | null | 'failed'> {
  if (!managedIds.includes(id)) return null;

  const { data, error } = await supabaseAdmin
    .from('departments')
    .select('id, name, parent_id, monthly_budget_krw, user_monthly_budget_krw')
    .eq('id', id)
    .eq('organization_id', organizationId)
    .maybeSingle();
  if (error) {
    console.error('[departments] 부서 조회 실패', error);
    return 'failed';
  }
  return (data as TargetDepartment | null) ?? null;
}

/** 부서 수정 — 이름 변경 / 상위 부서 이동 */
export async function PATCH(request: NextRequest, { params }: { params: { id: string } }) {
  const ctx = await requireAdminOrg();
  if ('error' in ctx) return ctx.error;

  const managedIds = await getManagedDepartmentIds(ctx.departmentId);
  const target = await loadDepartment(params.id, ctx.organizationId, managedIds);
  if (target === 'failed') return NextResponse.json(READ_FAILED, { status: 503 });
  if (!target) {
    return NextResponse.json({ ok: false, error: { message: '부서를 찾을 수 없습니다.' } }, { status: 404 });
  }

  let body: Record<string, unknown>;
  try {
    const parsed = await request.json();
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('not an object');
    body = parsed as Record<string, unknown>;
  } catch {
    return NextResponse.json({ ok: false, error: { message: '요청 형식이 올바르지 않습니다.' } }, { status: 400 });
  }
  const update: Record<string, unknown> = {};

  if (typeof body.name === 'string') {
    const name = body.name.trim();
    if (!name) {
      return NextResponse.json({ ok: false, error: { message: '부서명을 입력해주세요.' } }, { status: 400 });
    }
    update.name = name;
  }


  // ── 월 금액 한도 (0024) ──
  // 빈 값은 NULL로 되돌린다. 0을 저장하면 "제한 없음"과 "한 푼도 못 씀"이
  // 구분되지 않고, 후자를 의도해 0을 넣는 관리자는 없다.
  for (const [key, label] of [
    ['monthly_budget_krw', '부서 월 한도'],
    ['user_monthly_budget_krw', '1인당 월 한도'],
  ] as const) {
    if (body[key] === undefined) continue;
    const raw = body[key];
    if (raw === null || raw === '') {
      update[key] = null;
      continue;
    }
    const n = Number(raw);
    if (!Number.isFinite(n) || n < 0) {
      return NextResponse.json(
        { ok: false, error: { message: `${label}는 0 이상의 숫자여야 합니다.` } },
        { status: 400 }
      );
    }
    update[key] = n > 0 ? n : null;
  }

  // 새 상위 부서의 이름 — 보안 로그에 그때의 이름으로 남긴다
  let newParentName: string | null = null;

  if (body.parent_id !== undefined) {
    const parentId = typeof body.parent_id === 'string' && body.parent_id ? body.parent_id : null;

    if (parentId === target.id) {
      return NextResponse.json({ ok: false, error: { message: '자기 자신을 상위 부서로 지정할 수 없습니다.' } }, { status: 400 });
    }

    // parent_id를 null로 두면 그 부서가 기관 직속으로 올라간다. 검사가 없으면
    // 과 단위 관리자가 자기 부서를 최상위로 올려 상위 부서의 관리 범위에서
    // 빠져나갈 수 있다(관리 범위는 자기 부서 + 하위이므로 상위 관리자가
    // 그 부서를 더는 보지 못한다). 기관 직속 관리자만 허용한다.
    if (parentId === null && !ctx.isRootAdmin) {
      return NextResponse.json(
        { ok: false, error: { message: '부서를 최상위로 올리는 것은 기관 직속 부서의 관리자만 할 수 있습니다.' } },
        { status: 403 }
      );
    }

    if (parentId) {
      const parent = await loadDepartment(parentId, ctx.organizationId, managedIds);
      if (parent === 'failed') return NextResponse.json(READ_FAILED, { status: 503 });
      if (!parent) {
        return NextResponse.json({ ok: false, error: { message: '상위 부서를 찾을 수 없습니다.' } }, { status: 400 });
      }
      newParentName = parent.name;

      // 순환 방지: 자기 하위 부서를 상위로 지정하면 트리가 끊어진 고리가 된다.
      // 그 부서들은 어떤 최상위에도 닿지 못해 화면에서 사라지고 조회도 무한루프에 빠진다.
      // 하위 부서를 못 읽으면 옮기지 않는다(2026-11-18 — 예전엔 실패가 '하위 없음'이 되어 순환을 통과시켰다)
      const descendants = await departmentDescendantsStrict(target.id);
      if (!descendants) {
        return NextResponse.json({ ok: false, error: { message: '하위 부서를 확인하지 못해 옮기지 않았습니다. 잠시 뒤 다시 시도해 주세요.' } }, { status: 503 });
      }
      if (descendants.includes(parentId)) {
        return NextResponse.json(
          { ok: false, error: { message: '하위 부서를 상위 부서로 지정할 수 없습니다.' } },
          { status: 400 }
        );
      }
    }

    update.parent_id = parentId;
  }

  if (Object.keys(update).length === 0) {
    return NextResponse.json({ ok: false, error: { message: '변경할 내용이 없습니다.' } }, { status: 400 });
  }

  const { data: updated, error } = await supabaseAdmin
    .from('departments')
    .update(update)
    .eq('id', target.id)
    .eq('organization_id', ctx.organizationId)
    .select('id, name, parent_id, description, monthly_budget_krw, user_monthly_budget_krw')
    .single();

  if (error) {
    if (error.code === '23505') {
      return NextResponse.json({ ok: false, error: { message: '같은 이름의 부서가 이미 있습니다.' } }, { status: 409 });
    }
    console.error('[departments PATCH]', error);
    return NextResponse.json({ ok: false, error: { message: '부서 수정에 실패했습니다.' } }, { status: 500 });
  }

  // 실제로 달라진 것만 보안 로그에(2026-11-18 — 그 전에는 부서를 옮기거나 한도를 바꿔도 어디에도 남지 않았다).
  // 상위 부서 바꾸기는 관리 범위를 바꾸므로 high. 기록 실패는 고친 것을 되돌리지 않는다(실패는 운영 기록에 남는다)
  const changed = departmentChanges(target, update);
  if (changed) {
    await logSecurityEvent(
      ctx.departmentId,
      ctx.session.user.id,
      'department_updated',
      {
        department_id: target.id,
        dept_name: target.name,
        ...changed.changes,
        ...(changed.parentChanged
          ? { from_parent_name: await departmentNameOf(target.parent_id, ctx.organizationId), to_parent_name: newParentName }
          : {}),
        ...(ctx.session.user.isImpersonating ? { impersonating: true } : {}),
      },
      changed.severity
    );
  }

  return NextResponse.json({ ok: true, data: updated });
}

/** 부서 삭제 — 비어 있을 때만 */
export async function DELETE(_request: NextRequest, { params }: { params: { id: string } }) {
  const ctx = await requireAdminOrg();
  if ('error' in ctx) return ctx.error;

  const managedIds = await getManagedDepartmentIds(ctx.departmentId);
  const target = await loadDepartment(params.id, ctx.organizationId, managedIds);
  if (target === 'failed') return NextResponse.json(READ_FAILED, { status: 503 });
  if (!target) {
    return NextResponse.json({ ok: false, error: { message: '부서를 찾을 수 없습니다.' } }, { status: 404 });
  }

  if (target.id === ctx.departmentId) {
    return NextResponse.json({ ok: false, error: { message: '본인이 속한 부서는 삭제할 수 없습니다.' } }, { status: 400 });
  }

  // 하위 부서·소속 인원·비서, 그리고 **이 부서로 남은 기록**이 있으면 지우지 않는다(`department-delete.ts`).
  // 부서 행을 지우면 DB가 그 부서의 대화·문서를 함께 지우고, 직원·사용 기록·보안 로그의 부서 칸을 비운다.
  // 남은 것을 못 세면 지우지 않는다 — 예전에는 조회 오류가 '없음'이 되어 그대로 지웠다(2026-11-18).
  const check = await checkDepartmentDelete(target.id);
  if (!check.ok) {
    return NextResponse.json(
      { ok: false, error: { message: '부서에 남은 것을 확인하지 못해 삭제하지 않았습니다. 잠시 뒤 다시 시도해 주세요.' } },
      { status: 503 }
    );
  }

  const blocked = departmentDeleteMessage(check);
  if (blocked) {
    return NextResponse.json({ ok: false, error: { message: blocked } }, { status: 409 });
  }

  const { error } = await supabaseAdmin
    .from('departments')
    .delete()
    .eq('id', target.id)
    .eq('organization_id', ctx.organizationId);

  if (error) {
    // 확인과 삭제 사이에 생긴 기록·검사에 없는 표가 가리키면 DB가 막는다(23503)
    if (error.code === '23503') {
      return NextResponse.json(
        { ok: false, error: { message: '이 부서를 가리키는 기록이 남아 있어 삭제할 수 없습니다. 쓰지 않는 부서는 이름을 바꾸거나 다른 부서 아래로 옮겨 정리해 주세요.' } },
        { status: 409 }
      );
    }
    console.error('[departments DELETE]', error);
    return NextResponse.json({ ok: false, error: { message: '부서 삭제에 실패했습니다.' } }, { status: 500 });
  }

  await logSecurityEvent(
    ctx.departmentId,
    ctx.session.user.id,
    'department_deleted',
    {
      department_id: target.id,
      dept_name: target.name,
      parent_id: target.parent_id,
      parent_name: await departmentNameOf(target.parent_id, ctx.organizationId),
      ...(ctx.session.user.isImpersonating ? { impersonating: true } : {}),
    },
    'medium'
  );

  return NextResponse.json({ ok: true, data: { id: target.id } });
}
