import { NextRequest, NextResponse } from 'next/server';
import { getServerAuthSession } from '@/lib/auth';
import { getActorScope } from '@/lib/actor-scope';
import { supabaseAdmin } from '@/lib/supabaseAdmin';
import { AGENT_ACCESS_COLUMNS, canUseAgent, type AgentAccessInfo } from '@/lib/agent-permissions';
import { validateAppDefinition } from '@/lib/apps/definition';
import { generateWebhookToken } from '@/lib/apps/webhooks';
import { APP_MAX_WEBHOOKS_PER_USER, parseWebhookCreate, webhookView, type AppWebhookRowLike, WEBHOOK_COLUMNS } from '@/lib/apps/webhook-spec';

export const dynamic = 'force-dynamic';
const fail = (message: string, status: number) => NextResponse.json({ ok: false, error: { message } }, { status });
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
type WebhookRow = AppWebhookRowLike & { agent: { name: string } | { name: string }[] | null };
const agentName = (row: WebhookRow) => (Array.isArray(row.agent) ? row.agent[0]?.name : row.agent?.name) ?? null;

/** 내 연동 목록 — 요청자의 것만(관리자도 남의 연동은 보지 못한다). 토큰 해시는 내보내지 않는다 */
export async function GET() {
  const session = await getServerAuthSession();
  if (!session?.user?.id) return fail('인증이 필요합니다.', 401);
  const { data, error } = await supabaseAdmin.from('app_webhooks').select(`${WEBHOOK_COLUMNS}, agent:agents(name)`)
    .eq('user_id', session.user.id).order('created_at', { ascending: false });
  if (error) return fail('연동을 불러오지 못했습니다.', 503);
  const now = Date.now();
  return NextResponse.json({ ok: true, data: ((data ?? []) as WebhookRow[]).map(row => webhookView(row, agentName(row), now)) });
}

/**
 * 연동 만들기 — 지금 앱 판으로 만든다. 파일 첨부가 필수인 앱은 만들 수 없고, 쓸 수 있는 연동은 한 사람당 5개.
 * **토큰 원문은 이 응답에서 한 번만** 돌려주고 DB에는 SHA-256만 남긴다
 */
export async function POST(request: NextRequest) {
  const session = await getServerAuthSession();
  if (!session?.user?.id) return fail('인증이 필요합니다.', 401);
  const actor = await getActorScope(session);
  if (!actor?.organizationId) return fail('기관 소속을 확인할 수 없습니다.', 403);
  if (session.user.isImpersonating) return fail('대리 접근 중에는 연동 토큰을 만들 수 없습니다.', 403);
  const body = await request.json().catch(() => null) as Record<string, unknown> | null;
  if (!body || typeof body !== 'object') return fail('요청 본문을 확인해 주세요.', 400);
  const { agent_id, app_version } = body;
  if (typeof agent_id !== 'string' || !UUID.test(agent_id)) return fail('앱을 확인해 주세요.', 400);
  if (typeof app_version !== 'number' || !Number.isInteger(app_version)) return fail('앱 판을 확인해 주세요.', 400);
  const spec = parseWebhookCreate(body);
  if (!spec.ok) return fail(spec.message, 400);

  const { data: agent, error: agentError } = await supabaseAdmin.from('agents')
    .select(`${AGENT_ACCESS_COLUMNS}, name, app_definition`).eq('id', agent_id).is('deleted_at', null).maybeSingle();
  if (agentError) return fail('앱을 불러오지 못했습니다.', 503);
  const row = agent as (AgentAccessInfo & { name: string; app_definition: unknown }) | null;
  if (!row || !canUseAgent(row, actor)) return fail('이 앱을 사용할 수 없습니다.', 404);
  const definition = validateAppDefinition(row.app_definition);
  if (!definition.ok || !definition.value) return fail('입력형 앱만 연동할 수 있습니다.', 400);
  if (definition.value.attachments?.required) return fail('파일 첨부가 필수인 앱은 연동할 수 없습니다.', 400);
  if (row.version !== app_version) return fail('앱 설정이 변경됐습니다. 앱을 새로 열어 입력 항목을 확인해 주세요.', 409);

  const now = Date.now();
  const { count, error: countError } = await supabaseAdmin.from('app_webhooks').select('id', { count: 'exact', head: true })
    .eq('user_id', session.user.id).eq('status', 'active').gt('expires_at', new Date(now).toISOString());
  if (countError) return fail('연동을 확인하지 못했습니다.', 503);
  if ((count ?? 0) >= APP_MAX_WEBHOOKS_PER_USER) return fail(`쓸 수 있는 연동은 한 사람당 ${APP_MAX_WEBHOOKS_PER_USER}개까지입니다. 쓰지 않는 연동을 회수한 뒤 다시 만들어 주세요.`, 400);

  const token = generateWebhookToken();
  const { data: created, error } = await supabaseAdmin.from('app_webhooks').insert({
    agent_id, user_id: session.user.id, department_id: actor.departmentId, organization_id: actor.organizationId, app_version,
    name: spec.name, token_hash: token.hash, token_prefix: token.prefix, status: 'active',
    expires_at: new Date(now + spec.expiryDays * 86_400_000).toISOString(),
  }).select(WEBHOOK_COLUMNS).single();
  if (error || !created) return fail('연동을 저장하지 못했습니다.', 503);
  return NextResponse.json({ ok: true, data: { webhook: webhookView(created as AppWebhookRowLike, row.name, now), token: token.token } }, { status: 201 });
}
