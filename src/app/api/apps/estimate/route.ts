import { NextResponse } from 'next/server';
import { getServerAuthSession } from '@/lib/auth';
import { actorScopeOr503 } from '@/lib/actor-scope-response';
import { readJsonObject, BAD_BODY_MESSAGE } from '@/lib/request-body';
import { supabaseAdmin } from '@/lib/supabaseAdmin';
import { AGENT_ACCESS_COLUMNS, canUseAgent, type AgentAccessInfo } from '@/lib/agent-permissions';
import { appOutputInstruction, renderAppInput, validateAppDefinition, APP_MAX_FILES } from '@/lib/apps/definition';
import { estimateAppCalls } from '@/lib/apps/call-estimate';
import { readAllowedModelIds, resolveModel } from '@/lib/model-policy';
import { estimateRunCostKrw } from '@/lib/usage-reservation';

export const dynamic = 'force-dynamic';

const fail = (message: string, status: number) => NextResponse.json({ ok: false, error: { message } }, { status });

/**
 * 입력형 앱 실행 전 '많으면 쓸 금액' 어림(2026-11-26) — 실행할 때 사용량 예약(0122)이 잡는 것과 같은 규칙(`estimateRunCostKrw`,
 * 예상 AI 호출 수 `estimateAppCalls`, 기관 정책으로 고른 모델)으로. 다만 **첨부·문서·찾은 근거의 글은 아직 모르므로 빼고**
 * 지시문·입력 글만으로 센다 — 화면은 '첨부·문서 내용 빼고'라고 밝힌다. 한도 판정·예약은 하지 않는다(보여 주기만).
 * 몸 `{ agent_id, app_inputs, files }`(files = 붙일 파일·문서 수). 쓸 수 있는 앱만, 입력이 앱 규칙에 안 맞으면 400(그대로 실행해도 거절된다)
 */
export async function POST(request: Request) {
  const session = await getServerAuthSession();
  if (!session?.user?.id) return fail('로그인이 필요합니다.', 401);
  const actor = await actorScopeOr503(session);
  if (actor instanceof Response) return actor;
  if (!actor?.organizationId) return fail('소속을 확인할 수 없습니다.', 403);
  const body = await readJsonObject(request);
  if (!body) return fail(BAD_BODY_MESSAGE, 400);
  const agentId = typeof body.agent_id === 'string' && /^[0-9a-f-]{36}$/i.test(body.agent_id) ? body.agent_id : null;
  if (!agentId) return fail('앱을 찾을 수 없습니다.', 404);
  const files = Number.isInteger(body.files) && (body.files as number) >= 0 && (body.files as number) <= APP_MAX_FILES ? (body.files as number) : null;
  if (files === null) return fail(`붙일 파일·문서 수는 0~${APP_MAX_FILES}로 보내 주세요.`, 400);

  const { data, error } = await supabaseAdmin.from('agents').select(`${AGENT_ACCESS_COLUMNS}, system_prompt, model_id, app_definition, agent_type`).eq('id', agentId).maybeSingle();
  if (error) return fail('앱을 지금 읽지 못했습니다. 잠시 뒤 다시 시도해 주세요.', 503);
  const agent = data as (AgentAccessInfo & { system_prompt: string | null; model_id: string | null; app_definition: unknown; agent_type: string | null }) | null;
  if (!agent || agent.agent_type === 'link' || !canUseAgent(agent, actor)) return fail('앱을 찾을 수 없습니다.', 404);
  const definition = validateAppDefinition(agent.app_definition ?? null);
  if (!definition.ok || !definition.value) return fail('입력형 앱이 아닙니다.', 400);
  const input = renderAppInput(definition.value, body.app_inputs ?? {});
  if (!input.ok) return fail(input.message, 400);

  // 모델 — 실행과 같이 기관 허용 목록으로 고른다. 정책을 못 읽으면 어림하지 않는다(실행은 가장 좁게 닫는데, 여기서 다른 모델로 어림하면 틀린 금액이 된다)
  const allowed = await readAllowedModelIds(actor.organizationId);
  if (!allowed) return fail('기관 모델 설정을 지금 읽지 못했습니다. 잠시 뒤 다시 시도해 주세요.', 503);
  const { modelId } = resolveModel(agent.model_id, allowed);
  const calls = estimateAppCalls(definition.value, input.inputs, files);
  const baseChars = (agent.system_prompt ?? '').length + appOutputInstruction(definition.value).length + input.message.length;
  const maxKrw = estimateRunCostKrw({ modelId, calls: calls.max, webSearches: calls.webSearches, baseChars });
  return NextResponse.json({ ok: true, data: { calls: calls.max, maxKrw, modelId } });
}
