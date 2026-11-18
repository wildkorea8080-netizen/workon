import { NextRequest, NextResponse } from 'next/server';
import { getServerAuthSession, isAdminSession } from '@/lib/auth';
import { supabaseAdmin } from '@/lib/supabaseAdmin';
import { getManagedDepartmentIds } from '@/lib/department-scope';
import { logSecurityEvent } from '@/lib/security-log';

export const dynamic = 'force-dynamic';

/**
 * 직원 정보 수정 — 부서 이동, 권한 변경.
 *
 * 관리 범위는 관리자의 부서와 그 하위 부서입니다.
 * 대상 직원과 옮길 부서가 **모두** 이 범위 안에 있어야 합니다.
 * 한쪽만 검사하면 범위 밖 직원을 끌어오거나, 관리 밖 부서로 밀어낼 수 있습니다.
 *
 * (2026-11-18) 바꾼 것은 보안 로그에 남긴다 — 권한(`user_role_changed`, high)·부서(`user_department_changed`)·개인 월 한도
 * (`user_budget_changed`)를 전후 값과 함께. 예전에는 직원을 관리자로 올려도 어디에도 남지 않았다(슈퍼관리자의 같은 조작은 남았다).
 * 슈퍼관리자 계정·탈퇴한 계정은 대상이 아니고, 대리 접근 중에는 권한을 바꾸지 못한다(기록이 그 기관 관리자 이름으로 남으므로).
 */

/** `numeric(14,2)`에 들어가는 가장 큰 금액 — 넘으면 DB 오류 대신 안내 */
const MAX_BUDGET_KRW = 999_999_999_999;

export async function PATCH(request: NextRequest, { params }: { params: { id: string } }) {
  try {
    const session = await getServerAuthSession();
    if (!session?.user?.id || !isAdminSession(session)) {
      return NextResponse.json(
        { ok: false, error: { message: '관리자 권한이 필요합니다.' } },
        { status: 403 }
      );
    }

    const adminDeptId = session.user.departmentId;
    if (!adminDeptId) {
      return NextResponse.json(
        { ok: false, error: { message: '부서 정보를 찾을 수 없습니다.' } },
        { status: 403 }
      );
    }

    const managedDeptIds = await getManagedDepartmentIds(adminDeptId);

    // 대상 직원이 관리 범위 안인지
    const { data: target, error: targetError } = await supabaseAdmin
      .from('users')
      .select('id, department_id, role, monthly_budget_krw')
      .eq('id', params.id)
      .eq('is_super_admin', false)
      .is('deleted_at', null)
      .maybeSingle();

    if (targetError) {
      console.error('[users PATCH] 대상 조회', targetError);
      return NextResponse.json(
        { ok: false, error: { message: '직원 정보를 불러오지 못했습니다. 잠시 뒤 다시 시도해 주세요.' } },
        { status: 500 }
      );
    }

    if (!target || !target.department_id || !managedDeptIds.includes(target.department_id)) {
      return NextResponse.json(
        { ok: false, error: { message: '관리 권한이 없는 직원입니다.' } },
        { status: 403 }
      );
    }

    const body = await request.json();
    const update: Record<string, unknown> = {};

    if (body.department_id !== undefined) {
      const newDeptId = typeof body.department_id === 'string' ? body.department_id : '';
      if (!newDeptId) {
        return NextResponse.json(
          { ok: false, error: { message: '옮길 부서를 지정해주세요.' } },
          { status: 400 }
        );
      }
      if (!managedDeptIds.includes(newDeptId)) {
        return NextResponse.json(
          { ok: false, error: { message: '관리 범위 밖의 부서로는 옮길 수 없습니다.' } },
          { status: 403 }
        );
      }
      update.department_id = newDeptId;
    }

    // ── 개인 월 한도 (0024) ──
    // 부서 기본값(user_monthly_budget_krw)을 덮어쓰는 예외다. 담당 업무가
    // 무거운 직원 한둘에게 더 주는 용도이지 전원에게 적으라는 뜻이 아니다.
    if (body.monthly_budget_krw !== undefined) {
      const raw = body.monthly_budget_krw;
      if (raw === null || raw === '') {
        // 비우면 부서 기본값으로 되돌아간다. 0을 저장하면 "부서 기본값 따름"과
        // "한 푼도 못 씀"이 구분되지 않는다.
        update.monthly_budget_krw = null;
      } else {
        const n = Number(raw);
        if (!Number.isFinite(n) || n < 0) {
          return NextResponse.json(
            { ok: false, error: { message: '월 한도는 0 이상의 숫자여야 합니다.' } },
            { status: 400 }
          );
        }
        if (n > MAX_BUDGET_KRW) {
          return NextResponse.json(
            { ok: false, error: { message: '월 한도가 너무 큽니다.' } },
            { status: 400 }
          );
        }
        update.monthly_budget_krw = n > 0 ? n : null;
      }
    }

    if (body.role !== undefined) {
      // 대리 접근 중의 조작은 그 기관 관리자 이름으로 기록된다 — 권한 변경은 슈퍼관리자 계정 관리에서(그쪽은 슈퍼관리자 이름으로 남는다)
      if (session.user.isImpersonating) {
        return NextResponse.json(
          { ok: false, error: { message: '대리 접근 중에는 직원 권한을 바꿀 수 없습니다. 슈퍼관리자 계정 관리에서 바꿔 주세요.' } },
          { status: 403 }
        );
      }
      const role = String(body.role).toUpperCase();
      if (!['ADMIN', 'USER'].includes(role)) {
        return NextResponse.json(
          { ok: false, error: { message: '권한은 ADMIN 또는 USER만 가능합니다.' } },
          { status: 400 }
        );
      }
      // 자기 자신의 권한을 낮춰 관리자가 한 명도 없는 상태가 되는 것을 막는다
      if (params.id === session.user.id && role !== 'ADMIN') {
        return NextResponse.json(
          { ok: false, error: { message: '본인의 관리자 권한은 해제할 수 없습니다.' } },
          { status: 400 }
        );
      }
      update.role = role;
    }

    if (Object.keys(update).length === 0) {
      return NextResponse.json(
        { ok: false, error: { message: '변경할 내용이 없습니다.' } },
        { status: 400 }
      );
    }

    const { data: updated, error } = await supabaseAdmin
      .from('users')
      .update(update)
      .eq('id', params.id)
      .select('id, email, full_name, role, department_id, created_at, departments(id, name)')
      .single();

    if (error) {
      console.error('[users PATCH]', error);
      return NextResponse.json(
        { ok: false, error: { message: '직원 정보 수정에 실패했습니다.' } },
        { status: 500 }
      );
    }

    const dept = Array.isArray((updated as any).departments)
      ? (updated as any).departments[0]
      : (updated as any).departments;

    // ── 바꾼 것을 보안 로그에 — 실제로 달라진 것만. 기록 실패는 되돌리지 않는다(실패는 운영 기록에 남는다) ──
    const base = { target_user_id: target.id, ...(session.user.isImpersonating ? { impersonating: true } : {}) };

    if (update.role !== undefined && update.role !== target.role) {
      await logSecurityEvent(adminDeptId, session.user.id, 'user_role_changed', { ...base, from_role: target.role, to_role: update.role }, 'high');
    }

    if (update.department_id !== undefined && update.department_id !== target.department_id) {
      // 부서 이름은 그때의 이름으로 남긴다(나중에 이름이 바뀌어도 기록은 그대로). 못 읽으면 id만
      const { data: names, error: nameError } = await supabaseAdmin
        .from('departments')
        .select('id, name')
        .in('id', [target.department_id, update.department_id as string]);
      const nameOf = (id: unknown) =>
        nameError ? null : ((names ?? []) as Array<{ id: string; name: string }>).find((d) => d.id === id)?.name ?? null;
      await logSecurityEvent(adminDeptId, session.user.id, 'user_department_changed', {
        ...base,
        from_department_id: target.department_id,
        to_department_id: update.department_id,
        from_department_name: nameOf(target.department_id),
        to_department_name: nameOf(update.department_id),
      }, 'medium');
    }

    if ('monthly_budget_krw' in update) {
      const before = target.monthly_budget_krw == null ? null : Number(target.monthly_budget_krw);
      const after = update.monthly_budget_krw as number | null;
      if (before !== after) {
        await logSecurityEvent(adminDeptId, session.user.id, 'user_budget_changed', { ...base, from_budget_krw: before, to_budget_krw: after }, 'medium');
      }
    }

    return NextResponse.json({
      ok: true,
      data: { ...updated, departments: undefined, department_name: dept?.name ?? null },
    });
  } catch (error) {
    console.error('[users PATCH] 오류:', error);
    return NextResponse.json(
      { ok: false, error: { message: '오류가 발생했습니다.' } },
      { status: 500 }
    );
  }
}
