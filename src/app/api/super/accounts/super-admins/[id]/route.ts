import { NextRequest, NextResponse } from 'next/server';
import { getSuperAdminFromRequest } from '@/lib/super-auth';
import { supabaseAdmin } from '@/lib/supabaseAdmin';
import { dbErrorText } from '@/lib/db-error-text';
import { writeAuditRow } from '@/lib/audit-write';

export const dynamic = 'force-dynamic';

/** 지금 사용 중인 슈퍼관리자 수 — 못 읽으면 null. */
async function activeSuperAdminCount(): Promise<number | null> {
  const { count, error } = await supabaseAdmin
    .from('users').select('id', { count: 'exact', head: true })
    .eq('is_super_admin', true).eq('is_active', true).is('deleted_at', null);
  return error || count === null ? null : count;
}

// PATCH: 슈퍼관리자 사용 중지·다시 사용
//
// 2026-11-19 — ① `isActive`가 참·거짓이 아니어도 그대로 DB에 보냈고 ② 대상이 없거나 슈퍼관리자가 아니면
// `.single()` 오류로 500이었으며 ③ 두 슈퍼관리자가 거의 동시에 서로를 끄면 둘 다 '2명 사용 중'을 보고 통과해
// **사용 중인 슈퍼관리자가 0명**이 될 수 있었다 — 첫 설정(`/api/super/auth/setup`)은 슈퍼관리자가 하나라도
// 있으면 막으므로 DB를 직접 고치지 않고는 아무도 들어올 수 없다. 이제 끈 뒤 다시 세어 0명이면 되돌린다.
export async function PATCH(
  request: NextRequest,
  { params }: { params: { id: string } }
) {
  const admin = getSuperAdminFromRequest(request);
  if (!admin) return NextResponse.json({ ok: false, error: '인증 필요' }, { status: 401 });

  const body = await request.json().catch(() => null) as { isActive?: unknown } | null;
  const isActive = body?.isActive;
  if (typeof isActive !== 'boolean')
    return NextResponse.json({ ok: false, error: '요청 형식이 올바르지 않습니다.' }, { status: 400 });

  try {
    if (!isActive && params.id === admin.sub)
      return NextResponse.json({ ok: false, error: '본인 계정은 비활성화할 수 없습니다.' }, { status: 400 });

    const { data: before, error: beforeError } = await supabaseAdmin
      .from('users').select('id, is_active')
      .eq('id', params.id).eq('is_super_admin', true).is('deleted_at', null)
      .maybeSingle();
    if (beforeError) return NextResponse.json({ ok: false, error: '계정을 확인하지 못했습니다. 잠시 뒤 다시 시도해 주세요.' }, { status: 503 });
    if (!before) return NextResponse.json({ ok: false, error: '슈퍼관리자를 찾을 수 없습니다.' }, { status: 404 });

    if (!isActive && before.is_active) {
      // 마지막 1명은 끄지 않는다 — 못 세면 끄지 않음
      const count = await activeSuperAdminCount();
      if (count === null) return NextResponse.json({ ok: false, error: '사용 중인 슈퍼관리자 수를 확인하지 못했습니다. 잠시 뒤 다시 시도해 주세요.' }, { status: 503 });
      if (count <= 1) return NextResponse.json({ ok: false, error: '최소 1명의 슈퍼관리자가 필요합니다.' }, { status: 400 });
    }

    const { data, error } = await supabaseAdmin
      .from('users')
      .update({ is_active: isActive })
      .eq('id', params.id)
      .eq('is_super_admin', true)
      .is('deleted_at', null)
      .select('id, email, is_active').maybeSingle();

    if (error) throw error;
    if (!data) return NextResponse.json({ ok: false, error: '슈퍼관리자를 찾을 수 없습니다.' }, { status: 404 });

    if (!isActive && before.is_active) {
      // 거의 동시에 다른 슈퍼관리자도 꺼졌으면 0명이 될 수 있다 — 다시 세어 0명(또는 못 셈)이면 되돌린다
      const after = await activeSuperAdminCount();
      if (after === null || after < 1) {
        const { error: undoError } = await supabaseAdmin
          .from('users').update({ is_active: true }).eq('id', params.id).eq('is_super_admin', true);
        if (undoError) console.error('[super-admins PATCH] 사용 중지를 되돌리지 못함', undoError.code);
        return NextResponse.json({ ok: false, error: '사용 중인 슈퍼관리자가 남지 않아 사용 중지를 되돌렸습니다. 잠시 뒤 다시 시도해 주세요.' }, { status: 409 });
      }
    }

    // 조작 기록(2026-11-17) — 바뀐 때만
    if (before.is_active !== data.is_active) {
      await writeAuditRow('super_admin_logs', {
        admin_user_id: admin.sub,
        action: 'super_admin_updated',
        target_type: 'user',
        target_id: params.id,
        before_data: { is_active: before.is_active },
        after_data: { is_active: data.is_active },
      }, 'super_admin_updated');
    }
    return NextResponse.json({ ok: true, data });
  } catch (err: any) {
    return NextResponse.json({ ok: false, error: dbErrorText(err) }, { status: 500 });
  }
}
