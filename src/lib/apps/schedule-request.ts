// src/lib/apps/schedule-request.ts
// 예약 만들기(POST)와 고치기(PUT)가 같은 검사를 거친다 — 지금 앱 판 기준 입력·문서·시각.
// 라우트 파일은 핸들러 말고는 내보낼 수 없어 여기 둔다.
import type { ActorScope } from '@/lib/agent-permissions';
import { AGENT_ACCESS_COLUMNS, canUseAgent, type AgentAccessInfo } from '@/lib/agent-permissions';
import { supabaseAdmin } from '@/lib/supabaseAdmin';
import { renderAppInput, validateAppDefinition } from '@/lib/apps/definition';
import { appDocumentChoice, CHOSEN_DOCUMENTS_UNAVAILABLE, verifyChosenDocuments } from '@/lib/apps/app-document-choice';
import { parseScheduleSpec, type AppScheduleSpec } from '@/lib/apps/schedule-spec';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type ScheduleRequest = {
  agentId: string; agentName: string; appVersion: number; inputs: Record<string, string>; documentIds: string[]; spec: AppScheduleSpec;
  /** 실행을 마치면 메일로 알림(0069) — 보내지 않으면 거짓 */
  notifyOnSuccess: boolean;
};
export type ScheduleRequestCheck = { ok: true; value: ScheduleRequest } | { ok: false; status: number; message: string };

/**
 * 예약 요청 본문 검사 — 앱을 지금 쓸 수 있는지(요청자 기준), 입력형 앱인지, 화면이 본 판이 지금 판인지, 입력·문서함 문서·시각이 맞는지.
 * 올린 파일은 받지 않는다(첨부는 한 대화에 묶인다). 파일이 필수인 앱은 문서함 문서를 골랐을 때만 통과한다(0062)
 */
export async function checkScheduleRequest(body: Record<string, unknown>, actor: ActorScope): Promise<ScheduleRequestCheck> {
  const fail = (message: string, status = 400): ScheduleRequestCheck => ({ ok: false, status, message });
  const { agent_id, app_version, inputs } = body;
  if (typeof agent_id !== 'string' || !UUID.test(agent_id)) return fail('앱을 확인해 주세요.');
  if (typeof app_version !== 'number' || !Number.isInteger(app_version)) return fail('앱 판을 확인해 주세요.');
  const spec = parseScheduleSpec(body);
  if (!spec.ok) return fail(spec.message);
  if (body.notify_on_success !== undefined && typeof body.notify_on_success !== 'boolean') return fail('완료 메일 받기는 참·거짓으로 보내 주세요.');

  const { data: agent, error: agentError } = await supabaseAdmin.from('agents')
    .select(`${AGENT_ACCESS_COLUMNS}, name, app_definition`).eq('id', agent_id).is('deleted_at', null).maybeSingle();
  if (agentError) return fail('앱을 불러오지 못했습니다.', 503);
  const row = agent as (AgentAccessInfo & { name: string; app_definition: unknown }) | null;
  if (!row || !canUseAgent(row, actor)) return fail('이 앱을 사용할 수 없습니다.', 404);
  const definition = validateAppDefinition(row.app_definition);
  if (!definition.ok || !definition.value) return fail('입력형 앱만 예약할 수 있습니다.');
  const choice = appDocumentChoice(definition.value.attachments, body.document_ids, '예약');
  if (!choice.ok) return fail(choice.message);
  if (row.version !== app_version) return fail('앱 설정이 변경됐습니다. 앱을 새로 열어 입력 항목을 확인해 주세요.', 409);
  const input = renderAppInput(definition.value, inputs);
  if (!input.ok) return fail(input.message);
  const verified = await verifyChosenDocuments(agent_id, actor, choice.ids);
  if (verified === 'error') return fail('고른 문서를 확인하지 못했습니다.', 503);
  if (verified === 'unavailable') return fail(CHOSEN_DOCUMENTS_UNAVAILABLE);
  return { ok: true, value: { agentId: agent_id, agentName: row.name, appVersion: app_version, inputs: input.inputs, documentIds: choice.ids, spec: spec.value, notifyOnSuccess: body.notify_on_success === true } };
}
