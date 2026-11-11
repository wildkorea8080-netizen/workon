import { NextRequest, NextResponse } from 'next/server';
import { getServerAuthSession } from '@/lib/auth';
import { getActorScope } from '@/lib/actor-scope';
import { supabaseAdmin } from '@/lib/supabaseAdmin';
import { ADMIN_LOCKED_MESSAGE } from '@/lib/apps/automation-admin-spec';
import { checkScheduleRequest } from '@/lib/apps/schedule-request';
import { copyAttachmentsForSchedule, keptFiles, removeScheduleFileObjects, scheduleFilesOf } from '@/lib/apps/schedule-files';
import {
  PAUSED_BY_USER, SCHEDULE_BUSY_MESSAGE, SCHEDULE_CLAIM_STALE_MS, editedStatus, nextRunAt, scheduleView, specColumns, specOfRow, type AppScheduleRowLike, SCHEDULE_COLUMNS,
} from '@/lib/apps/schedule-spec';

export const dynamic = 'force-dynamic';
const fail = (message: string, status: number) => NextResponse.json({ ok: false, error: { message } }, { status });
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
type Named = { agent: { name: string } | { name: string }[] | null };
const nameOf = (row: Named) => (Array.isArray(row.agent) ? row.agent[0]?.name : row.agent?.name) ?? null;

/** 예약 하나 — 고치기 화면이 저장한 입력·문서·시각을 미리 채운다. 내 예약만 */
export async function GET(_request: NextRequest, { params }: { params: { id: string } }) {
  const session = await getServerAuthSession();
  if (!session?.user?.id) return fail('인증이 필요합니다.', 401);
  if (!UUID.test(params.id)) return fail('예약을 확인해 주세요.', 400);
  const { data: row, error } = await supabaseAdmin.from('app_schedules').select(`${SCHEDULE_COLUMNS}, agent:agents(name)`)
    .eq('id', params.id).eq('user_id', session.user.id).maybeSingle();
  if (error) return fail('예약을 불러오지 못했습니다.', 503);
  if (!row) return fail('예약을 찾을 수 없습니다.', 404);
  return NextResponse.json({ ok: true, data: scheduleView(row as AppScheduleRowLike, nameOf(row as Named), Date.now()) });
}

/**
 * 예약 고치기 — 만들기와 같은 검사(지금 앱 판·입력·문서함 문서·올린 파일·시각)를 거쳐 입력·문서·파일·시각·앱 판을 바꾼다. 앱은 바꿀 수 없다(다른 앱은 새 예약).
 * 올린 파일(0073): `file_ids`는 남길 예약 파일(없으면 모두 남김), `attachment_ids`는 새로 붙일 첨부(예약 사본으로 복사). 뺀 파일의 사본은 저장한 뒤 지운다.
 * 지금 부서·기관으로 다시 적는다(부서가 바뀌어 멈춘 예약이 풀린다). 다음 실행 시각은 지금부터 다시 센다.
 * 직원이 멈춘 예약은 멈춘 채로, 실행기가 멈춘 예약은 다시 켠다(`editedStatus`). 관리자가 멈춘 예약은 403, 실행 중(차지가 살아 있음)이면 409
 */
export async function PUT(request: NextRequest, { params }: { params: { id: string } }) {
  const session = await getServerAuthSession();
  if (!session?.user?.id) return fail('인증이 필요합니다.', 401);
  if (!UUID.test(params.id)) return fail('예약을 확인해 주세요.', 400);
  const actor = await getActorScope(session);
  if (!actor?.organizationId) return fail('기관 소속을 확인할 수 없습니다.', 403);
  const body = await request.json().catch(() => null) as Record<string, unknown> | null;
  if (!body || typeof body !== 'object') return fail('요청 본문을 확인해 주세요.', 400);
  const { data: row, error } = await supabaseAdmin.from('app_schedules').select('id, agent_id, status, paused_reason, consecutive_failures, admin_paused_at, claimed_at, files')
    .eq('id', params.id).eq('user_id', session.user.id).maybeSingle();
  if (error) return fail('예약을 불러오지 못했습니다.', 503);
  if (!row) return fail('예약을 찾을 수 없습니다.', 404);
  const current = row as Pick<AppScheduleRowLike, 'agent_id' | 'status' | 'paused_reason' | 'consecutive_failures' | 'admin_paused_at' | 'files'> & { claimed_at: string | null };
  if (current.admin_paused_at) return fail(ADMIN_LOCKED_MESSAGE, 403);
  if (typeof body.agent_id === 'string' && body.agent_id.toLowerCase() !== current.agent_id.toLowerCase()) return fail('예약한 앱은 바꿀 수 없습니다. 다른 앱은 새로 예약해 주세요.', 400);
  const now = Date.now();
  const stale = new Date(now - SCHEDULE_CLAIM_STALE_MS).toISOString();
  if (current.claimed_at && Date.parse(current.claimed_at) > now - SCHEDULE_CLAIM_STALE_MS) return fail(SCHEDULE_BUSY_MESSAGE, 409);
  const currentFiles = scheduleFilesOf(current.files);
  const kept = keptFiles(currentFiles, body.file_ids);
  if (!kept) return fail('남길 예약 파일을 확인해 주세요.', 400);
  const checked = await checkScheduleRequest({ ...body, agent_id: current.agent_id }, actor, kept.length);
  if (!checked.ok) return fail(checked.message, checked.status);
  const { agentName, appVersion, inputs, documentIds, spec, notifyOnSuccess, exportHwpx, attachmentIds } = checked.value;
  const copied = await copyAttachmentsForSchedule({ userId: session.user.id, organizationId: actor.organizationId }, attachmentIds);
  if (!copied.ok) return fail(copied.message, copied.status);
  const nowIso = new Date(now).toISOString();
  // 읽은 뒤 관리자가 멈췄거나 실행기가 차지했으면 바뀐 행이 없다(다음 실행 시각을 앞으로 미루므로 차지 직전에 고쳐도 그 차례는 차지되지 않는다)
  const { data: updated, error: updateError } = await supabaseAdmin.from('app_schedules').update({
    app_version: appVersion, inputs, document_ids: documentIds, files: [...kept, ...copied.files], ...specColumns(spec), notify_on_success: notifyOnSuccess, export_hwpx: exportHwpx, ...editedStatus(current),
    department_id: actor.departmentId, organization_id: actor.organizationId,
    claimed_at: null, next_run_at: nextRunAt(spec, now).toISOString(), updated_at: nowIso,
    // 입력을 고쳤으니 멈춘 실행을 이어 가지 않는다(0074)
    resume_message_id: null, resume_count: 0,
  }).eq('id', params.id).eq('user_id', session.user.id).is('admin_paused_at', null).or(`claimed_at.is.null,claimed_at.lt.${stale}`)
    .select(SCHEDULE_COLUMNS).maybeSingle();
  if (updateError || !updated) await removeScheduleFileObjects(copied.files, '예약 고치기 실패 뒤 정리');
  if (updateError) return fail('예약을 고치지 못했습니다.', 503);
  if (!updated) return fail('예약이 그 사이 실행되었거나 관리자가 멈췄습니다. 목록을 새로 열어 확인해 주세요.', 409);
  const keptIds = new Set(kept.map(f => f.id));
  await removeScheduleFileObjects(currentFiles.filter(f => !keptIds.has(f.id)), '예약 고치기에서 뺀 파일');
  return NextResponse.json({ ok: true, data: scheduleView(updated as AppScheduleRowLike, agentName, now) });
}

/** 지금 한 번 실행(2026-11-10)을 연달아 누르지 못하게 — 마지막 실행 뒤 이만큼 */
const RUN_NOW_COOLDOWN_MS = 10 * 60_000;

/**
 * 멈추기·다시 켜기·지금 한 번 실행 — 내 예약만. 다시 켜면 다음 실행 시각을 지금부터 다시 세고 실패 횟수를 지운다.
 * `run_now`(2026-11-10, 마이그레이션 없음)는 켜진 예약의 다음 실행 시각을 지금으로 당긴다 — 실행기(5분마다)가 다음 차례에 실행하고,
 * 그 뒤로는 원래 일정대로 돈다. 실행기가 잡고 있는 예약·방금(10분 안) 실행한 예약은 받지 않는다
 */
export async function PATCH(request: NextRequest, { params }: { params: { id: string } }) {
  const session = await getServerAuthSession();
  if (!session?.user?.id) return fail('인증이 필요합니다.', 401);
  if (!UUID.test(params.id)) return fail('예약을 확인해 주세요.', 400);
  const body = await request.json().catch(() => null) as { action?: unknown } | null;
  const action = body?.action;
  if (action !== 'pause' && action !== 'resume' && action !== 'run_now') return fail('할 일은 pause·resume·run_now입니다.', 400);
  const { data: row, error } = await supabaseAdmin.from('app_schedules').select(`${SCHEDULE_COLUMNS}, agent:agents(name)`)
    .eq('id', params.id).eq('user_id', session.user.id).maybeSingle();
  if (error) return fail('예약을 불러오지 못했습니다.', 503);
  if (!row) return fail('예약을 찾을 수 없습니다.', 404);
  // 관리자가 멈춘 예약(0050)은 직원이 켜지도, 멈춤 사유를 덮지도 못한다 — 지우기는 된다(직원의 자료다)
  if ((row as { admin_paused_at?: string | null }).admin_paused_at) return fail(ADMIN_LOCKED_MESSAGE, 403);
  const now = Date.now();
  if (action === 'run_now') {
    const r = row as { status?: string; last_run_at?: string | null; next_run_at?: string };
    if (r.status !== 'active') return fail('멈춘 예약입니다. 먼저 다시 켜 주세요.', 409);
    if (r.last_run_at && Date.parse(r.last_run_at) > now - RUN_NOW_COOLDOWN_MS) return fail('방금 실행한 예약입니다. 10분 뒤에 다시 눌러 주세요.', 429);
    const agentName = (() => { const a = (row as { agent: { name: string } | { name: string }[] | null }).agent; return (Array.isArray(a) ? a[0]?.name : a?.name) ?? null; })();
    // 이미 차례가 됐으면 그대로(곧 실행된다)
    if (r.next_run_at && Date.parse(r.next_run_at) <= now) return NextResponse.json({ ok: true, data: scheduleView(row as AppScheduleRowLike, agentName, now) });
    const nowIso = new Date(now).toISOString();
    const { data: due, error: dueError } = await supabaseAdmin.from('app_schedules').update({ next_run_at: nowIso, updated_at: nowIso })
      .eq('id', params.id).eq('user_id', session.user.id).eq('status', 'active').is('admin_paused_at', null).is('claimed_at', null).select(SCHEDULE_COLUMNS).maybeSingle();
    if (dueError) return fail('예약을 바꾸지 못했습니다.', 503);
    if (!due) return fail('지금 실행 중이거나 그 사이 바뀐 예약입니다. 잠시 뒤 다시 확인해 주세요.', 409);
    return NextResponse.json({ ok: true, data: scheduleView(due as AppScheduleRowLike, agentName, now) });
  }
  const patch = action === 'pause'
    ? { status: 'paused', paused_reason: PAUSED_BY_USER, updated_at: new Date(now).toISOString() }
    : { status: 'active', paused_reason: null, consecutive_failures: 0, claimed_at: null, next_run_at: nextRunAt(specOfRow(row as AppScheduleRowLike), now).toISOString(), updated_at: new Date(now).toISOString(), resume_message_id: null, resume_count: 0 };
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
  const { data, error } = await supabaseAdmin.from('app_schedules').delete().eq('id', params.id).eq('user_id', session.user.id).select('id, files');
  if (error) return fail('예약을 지우지 못했습니다.', 503);
  if (!data?.length) return fail('예약을 찾을 수 없습니다.', 404);
  // 예약 파일 사본(0073) — 행을 지운 뒤에 지운다(실패는 기록만)
  await removeScheduleFileObjects(scheduleFilesOf((data[0] as { files?: unknown }).files), '예약 삭제 뒤');
  return NextResponse.json({ ok: true, data: { id: params.id } });
}
