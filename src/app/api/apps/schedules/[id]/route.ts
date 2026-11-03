import { NextRequest, NextResponse } from 'next/server';
import { getServerAuthSession } from '@/lib/auth';
import { supabaseAdmin } from '@/lib/supabaseAdmin';
import { PAUSED_BY_USER, nextRunAt, scheduleView, specOfRow, type AppScheduleRowLike } from '@/lib/apps/schedule-spec';

export const dynamic = 'force-dynamic';
const fail = (message: string, status: number) => NextResponse.json({ ok: false, error: { message } }, { status });
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SCHEDULE_COLUMNS = 'id, agent_id, app_version, inputs, frequency, weekday, month_day, run_hour, run_minute, status, paused_reason, next_run_at, last_run_at, last_status, last_error, last_conversation_id, consecutive_failures, run_count, created_at';

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
  const now = Date.now();
  const patch = action === 'pause'
    ? { status: 'paused', paused_reason: PAUSED_BY_USER, updated_at: new Date(now).toISOString() }
    : { status: 'active', paused_reason: null, consecutive_failures: 0, claimed_at: null, next_run_at: nextRunAt(specOfRow(row as AppScheduleRowLike), now).toISOString(), updated_at: new Date(now).toISOString() };
  const { data: updated, error: updateError } = await supabaseAdmin.from('app_schedules').update(patch)
    .eq('id', params.id).eq('user_id', session.user.id).select(SCHEDULE_COLUMNS).maybeSingle();
  if (updateError || !updated) return fail('예약을 바꾸지 못했습니다.', 503);
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
