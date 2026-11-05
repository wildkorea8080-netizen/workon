import { NextRequest, NextResponse } from 'next/server';
import { getServerAuthSession } from '@/lib/auth';
import { getActorScope } from '@/lib/actor-scope';
import { supabaseAdmin } from '@/lib/supabaseAdmin';
import { AGENT_ACCESS_COLUMNS, canUseAgent, type AgentAccessInfo } from '@/lib/agent-permissions';
import { renderAppInput, validateAppDefinition } from '@/lib/apps/definition';
import { appDocumentChoice, CHOSEN_DOCUMENTS_UNAVAILABLE, verifyChosenDocuments } from '@/lib/apps/app-document-choice';
import { APP_MAX_SCHEDULES_PER_USER, nextRunAt, parseScheduleSpec, scheduleView, type AppScheduleRowLike, SCHEDULE_COLUMNS } from '@/lib/apps/schedule-spec';

export const dynamic = 'force-dynamic';
const fail = (message: string, status: number) => NextResponse.json({ ok: false, error: { message } }, { status });
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
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
  const { agent_id, app_version, inputs } = body;
  if (typeof agent_id !== 'string' || !UUID.test(agent_id)) return fail('앱을 확인해 주세요.', 400);
  if (typeof app_version !== 'number' || !Number.isInteger(app_version)) return fail('앱 판을 확인해 주세요.', 400);
  const spec = parseScheduleSpec(body);
  if (!spec.ok) return fail(spec.message, 400);

  const { data: agent, error: agentError } = await supabaseAdmin.from('agents')
    .select(`${AGENT_ACCESS_COLUMNS}, name, app_definition`).eq('id', agent_id).is('deleted_at', null).maybeSingle();
  if (agentError) return fail('앱을 불러오지 못했습니다.', 503);
  const row = agent as (AgentAccessInfo & { name: string; app_definition: unknown }) | null;
  if (!row || !canUseAgent(row, actor)) return fail('이 앱을 사용할 수 없습니다.', 404);
  const definition = validateAppDefinition(row.app_definition);
  if (!definition.ok || !definition.value) return fail('입력형 앱만 예약할 수 있습니다.', 400);
  const choice = appDocumentChoice(definition.value.attachments, body.document_ids, '예약');
  if (!choice.ok) return fail(choice.message, 400);
  const documentIds = choice.ids;
  if (row.version !== app_version) return fail('앱 설정이 변경됐습니다. 앱을 새로 열어 입력 항목을 확인해 주세요.', 409);
  const input = renderAppInput(definition.value, inputs);
  if (!input.ok) return fail(input.message, 400);
  const verified = await verifyChosenDocuments(agent_id, actor, documentIds);
  if (verified === 'error') return fail('고른 문서를 확인하지 못했습니다.', 503);
  if (verified === 'unavailable') return fail(CHOSEN_DOCUMENTS_UNAVAILABLE, 400);

  const { count, error: countError } = await supabaseAdmin.from('app_schedules').select('id', { count: 'exact', head: true }).eq('user_id', session.user.id);
  if (countError) return fail('예약을 확인하지 못했습니다.', 503);
  if ((count ?? 0) >= APP_MAX_SCHEDULES_PER_USER) return fail(`예약은 한 사람당 ${APP_MAX_SCHEDULES_PER_USER}개까지입니다. 쓰지 않는 예약을 지운 뒤 다시 만들어 주세요.`, 400);

  const now = Date.now();
  const { data: created, error } = await supabaseAdmin.from('app_schedules').insert({
    agent_id, user_id: session.user.id, department_id: actor.departmentId, organization_id: actor.organizationId,
    app_version, inputs: input.inputs, document_ids: documentIds,
    frequency: spec.value.frequency, weekday: spec.value.weekday, month_day: spec.value.monthDay, run_hour: spec.value.hour, run_minute: spec.value.minute,
    status: 'active', next_run_at: nextRunAt(spec.value, now).toISOString(),
  }).select(SCHEDULE_COLUMNS).single();
  if (error || !created) return fail('예약을 저장하지 못했습니다.', 503);
  return NextResponse.json({ ok: true, data: scheduleView(created as AppScheduleRowLike, row.name, now) }, { status: 201 });
}
