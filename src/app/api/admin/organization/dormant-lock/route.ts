import { NextRequest, NextResponse } from 'next/server';
import { getServerAuthSession, isAdminSession } from '@/lib/auth';
import { supabaseAdmin } from '@/lib/supabaseAdmin';
import { getActorScope } from '@/lib/actor-scope';
import { validDormantDays } from '@/lib/dormant-lock';

export const dynamic = 'force-dynamic';

/**
 * 장기 미접속 계정 잠금 켜기·끄기(2026-11-16, 0095) — 기관 전체 관리자만. `{ days: 30~365 | null }`.
 * 처음 켤 때 켠 때(`dormant_lock_since`)를 적어 그보다 앞의 미접속은 세지 않는다(켜는 순간 모두 잠기지 않게).
 * 이미 켜져 있으면 기간만 바꾸고 켠 때는 그대로. 끄면 둘 다 비운다(이미 잠긴 계정은 그대로 — 관리자가 '다시 사용'으로).
 * 보안 로그 high.
 */
export async function PUT(request: NextRequest) {
  const session = await getServerAuthSession();
  if (!session?.user?.id || !isAdminSession(session)) {
    return NextResponse.json({ ok: false, error: { message: '관리자 권한이 필요합니다.' } }, { status: 403 });
  }
  if (session.user.isImpersonating) {
    return NextResponse.json({ ok: false, error: { message: '대리 접근 중에는 바꿀 수 없습니다.' } }, { status: 403 });
  }
  const scope = await getActorScope(session);
  if (!scope?.managesWholeOrganization || !scope.organizationId) {
    return NextResponse.json({ ok: false, error: { message: '기관 전체 관리자(최상위 부서 소속)만 바꿀 수 있습니다.' } }, { status: 403 });
  }
  let body: { days?: unknown };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ ok: false, error: { message: '요청 형식이 올바르지 않습니다.' } }, { status: 400 });
  }
  const days = body.days === null ? null : body.days;
  if (days !== null && !validDormantDays(days)) {
    return NextResponse.json({ ok: false, error: { message: '기간은 30~365일 사이의 정수이거나 끄기(null)여야 합니다.' } }, { status: 400 });
  }

  const { data: before, error: readError } = await supabaseAdmin
    .from('organizations')
    .select('dormant_lock_days, dormant_lock_since')
    .eq('id', scope.organizationId)
    .maybeSingle();
  if (readError || !before) {
    return NextResponse.json({ ok: false, error: { message: '기관 정보를 불러오지 못했습니다.' } }, { status: 500 });
  }
  const patch = days === null
    ? { dormant_lock_days: null, dormant_lock_since: null }
    : { dormant_lock_days: days, dormant_lock_since: before.dormant_lock_since ?? new Date().toISOString() };
  const { data, error } = await supabaseAdmin
    .from('organizations')
    .update(patch)
    .eq('id', scope.organizationId)
    .select('dormant_lock_days, dormant_lock_since')
    .single();
  if (error) {
    return NextResponse.json({ ok: false, error: { message: '저장하지 못했습니다.' } }, { status: 500 });
  }

  try {
    await supabaseAdmin.from('security_logs').insert({
      department_id: scope.departmentId,
      user_id: session.user.id,
      event_type: 'dormant_lock_changed',
      details: { before_days: before.dormant_lock_days ?? null, after_days: days },
      severity: 'high',
      created_at: new Date().toISOString(),
    });
  } catch { /* 보안 로그 실패는 되돌리지 않는다 */ }

  return NextResponse.json({ ok: true, data });
}
