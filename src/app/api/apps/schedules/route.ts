import { NextRequest, NextResponse } from 'next/server';
import { getServerAuthSession } from '@/lib/auth';
import { getActorScope } from '@/lib/actor-scope';
import { supabaseAdmin } from '@/lib/supabaseAdmin';
import { checkScheduleRequest } from '@/lib/apps/schedule-request';
import { readScheduleSwitch } from '@/lib/apps/webhook-switch';
import { copyAttachmentsForSchedule, removeScheduleFileObjects } from '@/lib/apps/schedule-files';
import { APP_MAX_SCHEDULES_PER_USER, SCHEDULE_ORG_DISABLED_CREATE, nextRunAt, scheduleView, specColumns, type AppScheduleRowLike, SCHEDULE_COLUMNS } from '@/lib/apps/schedule-spec';

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
  // 기관이 예약 실행을 꺼 두었는지(0070) — 안내일 뿐이라 읽지 못하면 켜진 것으로 보인다
  const actor = await getActorScope(session).catch(() => null);
  const orgDisabled = actor?.organizationId ? await readScheduleSwitch(actor.organizationId).then(s => s.disabled).catch(() => false) : false;
  return NextResponse.json({ ok: true, data: ((data ?? []) as ScheduleRow[]).map(row => scheduleView(row, agentName(row), now, orgDisabled)) });
}

/**
 * 예약 만들기 — 지금 앱 판 기준으로 입력을 검사해 저장한다. 실행 화면에 붙인 읽힌 첨부(`attachment_ids`)는 예약 사본으로 복사해
 * 함께 저장하고(0073 — 실행마다 새 첨부로 다시 올린다), 문서함에서 고르기를 허용한 앱은 고른 문서(`document_ids` — 지금 고를 수 있는
 * 문서만)를 함께 저장한다(0062). 파일·문서는 합쳐 3개까지, 파일이 필수인 앱은 둘 중 하나가 있어야 한다. 실행 때는 저장한 문서의 지금 근거 판을 쓴다.
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
  const { agentId, agentName, appVersion, inputs, documentIds, spec, notifyOnSuccess, exportHwpx, attachmentIds } = checked.value;

  // 기관이 예약 실행을 꺼 두었으면 새 예약을 받지 않는다(0070) — 읽지 못하면 닫는다
  let orgDisabled: boolean;
  try { orgDisabled = (await readScheduleSwitch(actor.organizationId)).disabled; } catch { return fail('기관 설정을 확인하지 못했습니다.', 503); }
  if (orgDisabled) return fail(SCHEDULE_ORG_DISABLED_CREATE, 403);

  const { count, error: countError } = await supabaseAdmin.from('app_schedules').select('id', { count: 'exact', head: true }).eq('user_id', session.user.id);
  if (countError) return fail('예약을 확인하지 못했습니다.', 503);
  if ((count ?? 0) >= APP_MAX_SCHEDULES_PER_USER) return fail(`예약은 한 사람당 ${APP_MAX_SCHEDULES_PER_USER}개까지입니다. 쓰지 않는 예약을 지운 뒤 다시 만들어 주세요.`, 400);

  const copied = await copyAttachmentsForSchedule({ userId: session.user.id, organizationId: actor.organizationId }, attachmentIds);
  if (!copied.ok) return fail(copied.message, copied.status);
  const now = Date.now();
  const { data: created, error } = await supabaseAdmin.from('app_schedules').insert({
    agent_id: agentId, user_id: session.user.id, department_id: actor.departmentId, organization_id: actor.organizationId,
    app_version: appVersion, inputs, document_ids: documentIds, files: copied.files, ...specColumns(spec), notify_on_success: notifyOnSuccess, export_hwpx: exportHwpx,
    status: 'active', next_run_at: nextRunAt(spec, now).toISOString(),
  }).select(SCHEDULE_COLUMNS).single();
  if (error || !created) {
    await removeScheduleFileObjects(copied.files, '예약 저장 실패 뒤 정리');
    return fail('예약을 저장하지 못했습니다.', 503);
  }
  return NextResponse.json({ ok: true, data: scheduleView(created as AppScheduleRowLike, agentName, now) }, { status: 201 });
}
