import { NextRequest, NextResponse } from 'next/server';
import { getServerAuthSession } from '@/lib/auth';
import { supabaseAdmin } from '@/lib/supabaseAdmin';
import { ADMIN_LOCKED_MESSAGE } from '@/lib/apps/automation-admin-spec';
import { PAUSED_BY_USER, nextRunAt, scheduleView, specOfRow, type AppScheduleRowLike, SCHEDULE_COLUMNS } from '@/lib/apps/schedule-spec';

export const dynamic = 'force-dynamic';
const fail = (message: string, status: number) => NextResponse.json({ ok: false, error: { message } }, { status });
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** 멈추기·다시 켜기 — 내 예약만. 다시 켜면 다음 실행 시각을 지금부터 다시 세고 실패 횟수를 지운다 */
export async function PATCH(request: NextRequest, { params }: { params: { id: string } }) {
  const session = await getServerAuthSession();
  if (!session?.user?.id) return fail('인증이 필요합니다.', 401);
  if (!UUID.test(params.id)) return fail('예약을 확인해 주세요.', 400);
  const body = await request.json().catch(() => null) as { action?: unknown } | null;
  const action = body?.action;
  if (action !== 'pause' && action !== 'resume') return fail('할 일은 pause 또는 resume입니다.', 400);
  const { data: row, error } = await supabaseAdmin.from('app_schedules').select(`${SCHEDULE_COLUMNS}, agent:agents(name)`)
    .eq('id', params.id).eq('user_id', session.user.id).maybeSingle();
  if (error) return fail('예약을 불러오지 못했습니다.', 503);
  if (!row) return fail('예약을 찾을 수 없습니다.', 404);
  // 관리자가 멈춘 예약(0050)은 직원이 켜지도, 멈춤 사유를 덮지도 못한다 — 지우기는 된다(직원의 자료다)
  if ((row as { admin_paused_at?: string | null }).admin_paused_at) return fail(ADMIN_LOCKED_MESSAGE, 403);
  const now = Date.now();
  const patch = action === 'pause'
    ? { status: 'paused', paused_reason: PAUSED_BY_USER, updated_at: new Date(now).toISOString() }
    : { status: 'active', paused_reason: null, consecutive_failures: 0, claimed_at: null, next_run_at: nextRunAt(specOfRow(row as AppScheduleRowLike), now).toISOString(), updated_at: new Date(now).toISOString() };
  const { data: updated, error: updateError } = await supabaseAdmin.from('app_schedules').update(patch)
    .eq('id', params.id).eq('user_id', session.user.id).is('admin_paused_at', null).select(SCHEDULE_COLUMNS).maybeSingle();
  if (updateError) return fail('예약을 바꾸지 못했습니다.', 503);
  // 읽은 뒤 그 사이에 관리자가 멈췄으면 바뀐 행이 없다
  if (!updated) return fail(ADMIN_LOCKED_MESSAGE, 403);
  const agent = (row as { agent: { name: string } | { name: string }[] | null }).agent;
  return NextResponse.json({ ok: true, data: scheduleView(updated as AppScheduleRowLike, (Array.isArray(agent) ? agent[0]?.name : agent?.name) ?? null, now) });
}

export async function DELETE(_request: NextRequest, { params }: { params: { id: string } }) {
  const session = await getServerAuthSession();
  if (!session?.user?.id) return fail('인증이 필요합니다.', 401);
  if (!UUID.test(params.id)) return fail('예약을 확인해 주세요.', 400);
  const { data, error } = await supabaseAdmin.from('app_schedules').delete().eq('id', params.id).eq('user_id', session.user.id).select('id');
  if (error) return fail('예약을 지우지 못했습니다.', 503);
  if (!data?.length) return fail('예약을 찾을 수 없습니다.', 404);
  return NextResponse.json({ ok: true, data: { id: params.id } });
}
