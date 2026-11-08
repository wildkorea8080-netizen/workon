import { NextRequest, NextResponse } from 'next/server';
import { getServerAuthSession } from '@/lib/auth';
import { getActorScope } from '@/lib/actor-scope';
import { supabaseAdmin } from '@/lib/supabaseAdmin';
import { checkScheduleRequest } from '@/lib/apps/schedule-request';
import { APP_MAX_SCHEDULES_PER_USER, nextRunAt, scheduleView, specColumns, type AppScheduleRowLike, SCHEDULE_COLUMNS } from '@/lib/apps/schedule-spec';

export const dynamic = 'force-dynamic';
const fail = (message: string, status: number) => NextResponse.json({ ok: false, error: { message } }, { status });
type ScheduleRow = AppScheduleRowLike & { agent: { name: string } | { name: string }[] | null };
const agentName = (row: ScheduleRow) => (Array.isArray(row.agent) ? row.agent[0]?.name : row.agent?.name) ?? null;

/** 내 예약 목록 — 요청자의 것만(관리자도 남의 예약은 보지 못한다) */
export async function GET() {
  const session = await getServerAuthSession();
  if (!session?.user?.id) return fail('인증이 필요합니다.', 401);
  const { data, error } = await supabaseAdmin.from('app_schedules').select(`${SCHEDULE_COLUMNS}, agent:agents(name)`)
    .eq('user_id', session.user.id).order('next_run_at', { ascending: true });
  if (error) return fail('예약을 불러오지 못했습니다.', 503);
  const now = Date.now();
  return NextResponse.json({ ok: true, data: ((data ?? []) as ScheduleRow[]).map(row => scheduleView(row, agentName(row), now)) });
}

/**
 * 예약 만들기 — 지금 앱 판 기준으로 입력을 검사해 저장한다. 올린 파일은 예약할 수 없다(첨부는 한 대화에 묶인다).
 * 문서함에서 고르기를 허용한 앱은 고른 문서(`document_ids`, 3개까지 — 지금 고를 수 있는 문서만)를 함께 저장하고, 파일이 필수인 앱은
 * 그 경우에만 예약할 수 있다(0062). 실행 때는 저장한 문서의 지금 근거 판을 쓴다.
 * 한 사람당 5개까지. 실행은 예약한 사람의 권한·사용량으로 한다(`src/lib/apps/schedules.ts`)
 */
export async function POST(request: NextRequest) {
  const session = await getServerAuthSession();
  if (!session?.user?.id) return fail('인증이 필요합니다.', 401);
  const actor = await getActorScope(session);
  if (!actor?.organizationId) return fail('기관 소속을 확인할 수 없습니다.', 403);
  const body = await request.json().catch(() => null) as Record<string, unknown> | null;
  if (!body || typeof body !== 'object') return fail('요청 본문을 확인해 주세요.', 400);
  const checked = await checkScheduleRequest(body, actor);
  if (!checked.ok) return fail(checked.message, checked.status);
  const { agentId, agentName, appVersion, inputs, documentIds, spec, notifyOnSuccess } = checked.value;

  const { count, error: countError } = await supabaseAdmin.from('app_schedules').select('id', { count: 'exact', head: true }).eq('user_id', session.user.id);
  if (countError) return fail('예약을 확인하지 못했습니다.', 503);
  if ((count ?? 0) >= APP_MAX_SCHEDULES_PER_USER) return fail(`예약은 한 사람당 ${APP_MAX_SCHEDULES_PER_USER}개까지입니다. 쓰지 않는 예약을 지운 뒤 다시 만들어 주세요.`, 400);

  const now = Date.now();
  const { data: created, error } = await supabaseAdmin.from('app_schedules').insert({
    agent_id: agentId, user_id: session.user.id, department_id: actor.departmentId, organization_id: actor.organizationId,
    app_version: appVersion, inputs, document_ids: documentIds, ...specColumns(spec), notify_on_success: notifyOnSuccess,
    status: 'active', next_run_at: nextRunAt(spec, now).toISOString(),
  }).select(SCHEDULE_COLUMNS).single();
  if (error || !created) return fail('예약을 저장하지 못했습니다.', 503);
  return NextResponse.json({ ok: true, data: scheduleView(created as AppScheduleRowLike, agentName, now) }, { status: 201 });
}
