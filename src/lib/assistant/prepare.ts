// src/lib/assistant/prepare.ts
import type { Session } from 'next-auth';
import { supabaseAdmin } from '@/lib/supabaseAdmin';
import { getActorScope } from '@/lib/actor-scope';
import { canEditAgent, canUseAgent, AGENT_ACCESS_COLUMNS, type AgentAccessInfo } from '@/lib/agent-permissions';
import { readAppDraft, withDraftSettings } from '@/lib/apps/draft';
import { getCapabilityScope } from '@/lib/connector-scope';
import { checkTokenLimit, limitMessage } from '@/lib/usage-limit';
import { filterUserInput } from '@/lib/filter';
import { validateChatImages, type ChatImage } from '@/lib/chat-images';
import { getAllowedModelIds, resolveModel } from '@/lib/model-policy';
import { connectorCatalog } from '@/lib/connectors';
import { activeCapabilities, effectiveCapabilities, toolsFor } from '@/lib/capabilities';
import type { TurnContext, PrepareResult, TurnAttachment } from '@/lib/capabilities/types';
import type { CapabilityId } from '@/lib/capabilities/settings';
import {
  bindAttachments,
  checkAttachable,
  deleteConversationAttachments,
  listConversationAttachments,
  type AttachmentRecord,
} from '@/lib/attachments/store';
import { attachmentRequestError, toTurnAttachments } from './attachments';
import type { RetrievedChunk } from '@/lib/db';
import { buildSystemPrompt, buildUserContent, storedUserContent } from './prompt';
import { loadHistory } from './history';
import { validateAppDefinition, renderAppInput, appOutputInstruction, APP_MAX_FILES } from '@/lib/apps/definition';
import { appAttachmentMaterial } from '@/lib/apps/attachment-context';
import type { AttachmentExtract } from '@/lib/attachments/types';
import { LIBRARY_DOCUMENT_COLUMNS, loadLibraryDocuments, parseLibraryIds, type LibraryDocumentRow } from '@/lib/apps/library-documents';
import { SUPABASE_DOCUMENTS_BUCKET } from '@/lib/config';
import { loadTurnExtract } from '@/lib/capabilities/attachment-access';
import { restoreAppSteps, isInputOnlyRun } from '@/lib/apps/resume';
import type { AppStepRecord } from '@/lib/apps/pipeline';
import type { PrepareOutcome, PreparedTurn } from './types';

type AgentRow = AgentAccessInfo & {
  app_definition: unknown;
  name: string;
  system_prompt: string | null;
  model_id: string | null;
  capabilities: unknown;
  agent_type: string | null;
  app_draft?: unknown;
};

function reject(message: string, status: number, details?: Record<string, unknown>): PrepareOutcome {
  return { ok: false, status, message, details };
}

/**
 * 첫 턴이 첨부 묶기에서 거절됐을 때 방금 만든 대화를 치운다. 일부만 묶였을 수 있어
 * 첨부 저장소를 먼저 지운다 — 행만 연쇄 삭제되면 객체가 남는다. 실패해도 던지지 않는다.
 */
async function discardNewConversation(conversationId: string, userId: string): Promise<void> {
  await deleteConversationAttachments(conversationId);
  const { error } = await supabaseAdmin.from('conversations').delete().eq('id', conversationId).eq('user_id', userId);
  if (error) console.error('[assistant] 거절된 첫 턴의 대화를 지우지 못함:', conversationId, error.message);
}

/**
 * 한 턴을 준비한다. 여기서 거절되면 라우트가 JSON으로 답한다
 * (스트림 시작 전 실패 규약).
 */
export async function prepareTurn(session: Session, body: Record<string, unknown>): Promise<PrepareOutcome> {
  const { agent_id, message: rawMessage, conversation_id, images, attachment_ids } = body;
  // '문서 없이 일반 답변 받기'. 정확히 true일 때만 — 다른 값으로 문서 찾기가 꺼지면 안 된다
  const skipDocuments = body.skip_documents === true;

  if (typeof agent_id !== 'string' || !agent_id) return reject('에이전트 ID는 필수입니다.', 400);
  if (typeof rawMessage !== 'string' || !rawMessage.trim()) return reject('메시지는 필수입니다.', 400);
  let message: string = rawMessage;
  let appStepInputs: Record<string, string> | undefined;
  let appResumeRecords: AppStepRecord[] | undefined;
  let appResumeFrom: string | undefined;

  // 화면에서도 거르지만 그건 표시일 뿐이고 실제 제한은 여기서 건다.
  const imageError = validateChatImages(images);
  if (imageError) return reject(imageError, 400);
  const attachedImages: ChatImage[] = Array.isArray(images) ? (images as ChatImage[]) : [];

  // 소속을 알 수 없으면 거부한다. 추측해서 배정하면 타 기관 자료에 닿는다.
  const actor = await getActorScope(session);
  if (!actor || !actor.organizationId) {
    return reject('소속 부서가 지정되지 않았습니다. 기관 관리자에게 문의하세요.', 403);
  }

  // 사용자를 함께 넘긴다. 빠뜨리면 개인 한도가 조용히 적용되지 않는다.
  const limitStatus = await checkTokenLimit(actor.departmentId, actor.userId);
  if (!limitStatus.allowed) {
    return reject(limitMessage(limitStatus), 429, {
      reason: limitStatus.reason,
      usedTokens: limitStatus.usedTokens,
      limitTokens: limitStatus.limitTokens,
      budget: limitStatus.budget,
    });
  }

  const { data } = await supabaseAdmin
    .from('agents')
    .select(`${AGENT_ACCESS_COLUMNS}, name, system_prompt, model_id, capabilities, agent_type, app_definition, app_draft`)
    .eq('id', agent_id)
    .maybeSingle();
  const loadedAgent = data as AgentRow | null;

  if (!loadedAgent || loadedAgent.deleted_at || !loadedAgent.is_active) return reject('에이전트를 찾을 수 없습니다.', 404);
  let agent: AgentRow = loadedAgent;
  if (!canUseAgent(agent, actor)) return reject('해당 에이전트에 접근할 권한이 없습니다.', 403);
  if (agent.agent_type === 'link') return reject('링크형 비서는 대화할 수 없습니다.', 400);

  // 시험 판 실행(0053) — 고칠 수 있는 사람만, 실행 화면이 본 그 시험 판(`app_draft` = 저장 시각)일 때만, 새 실행에서만.
  // 지금 판 위에 시험 판의 이름·지시문·입력 설정·능력을 덮는다(모델·판 번호는 지금 판). 예약·연동은 이 칸을 보내지 않는다
  let appDraftSavedAt: string | undefined;
  if (body.app_draft !== undefined) {
    if (typeof body.app_draft !== 'string' || conversation_id || body.resume_message_id !== undefined) return reject('시험 판은 새 실행으로만 시험할 수 있습니다.', 400);
    if (!canEditAgent(agent, actor)) return reject('이 앱의 시험 판을 실행할 권한이 없습니다.', 403);
    const draft = readAppDraft(agent.app_draft);
    if (!draft || draft.saved_at !== body.app_draft) return reject('시험 판이 바뀌었거나 없습니다. 앱 설정을 새로 열어 확인해 주세요.', 409);
    if (draft.base_version !== agent.version) return reject('시험 판을 만든 뒤 앱이 새로 배포됐습니다. 지금 판을 보고 시험 판을 다시 저장해 주세요.', 409);
    agent = withDraftSettings(agent, draft);
    appDraftSavedAt = draft.saved_at;
  }

  const definition = validateAppDefinition(agent.app_definition ?? null);
  if (!definition.ok) return reject('앱의 입력 설정을 확인해 주세요.', 400);
  if (body.app_inputs !== undefined || (definition.value && !conversation_id)) {
    if (!definition.value) return reject('입력 폼이 없는 비서입니다.', 400);
    if (body.app_version !== agent.version) return reject('앱 설정이 변경됐습니다. 앱을 새로 열어 입력 항목을 확인해 주세요.', 409);
    const input = renderAppInput(definition.value, body.app_inputs);
    if (!input.ok) return reject(input.message, 400);
    message = input.message;
    appStepInputs = input.inputs;
  }
  // 문서함에서 고른 문서(2026-11-05) — 새 앱 실행에서만, 앱이 허용할 때만. 읽기는 대화를 만들기 전에(아래)
  const libraryIds = parseLibraryIds(body.app_document_ids);
  if (libraryIds === null) return reject('고른 문서를 확인해 주세요.', 400);
  if (libraryIds.length && (!appStepInputs || !definition.value?.attachments?.library || conversation_id)) return reject('이 앱은 문서함에서 문서를 고를 수 없습니다.', 400);
  if (body.resume_message_id !== undefined) {
    if (typeof body.resume_message_id !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(body.resume_message_id) || !appStepInputs || !definition.value?.steps?.length || conversation_id) return reject('입력형 앱의 중단 기록을 선택해 새 실행으로 이어 주세요.', 400);
    if (!isInputOnlyRun(Object.keys(agent.capabilities ?? {}), (Array.isArray(attachment_ids) ? attachment_ids.length : 0) + libraryIds.length) || attachedImages.length) return reject('자료·도구가 연결된 앱은 근거가 바뀔 수 있으므로 새로 실행해 주세요.', 409);
    const { data: saved, error: resumeError } = await supabaseAdmin.from('messages').select('id,agent_version,source_references,conversation:conversations!inner(user_id,agent_id)').eq('id', body.resume_message_id).eq('role', 'assistant').eq('conversation.user_id', actor.userId).eq('conversation.agent_id', agent_id).maybeSingle();
    if (resumeError) return reject('중단 기록을 확인하지 못했습니다.', 503);
    const owner = Array.isArray(saved?.conversation) ? saved.conversation[0] : saved?.conversation;
    if (!saved || owner?.user_id !== actor.userId || owner?.agent_id !== agent_id) return reject('중단 기록을 찾을 수 없습니다.', 404);
    if (saved.agent_version !== agent.version) return reject('앱 설정이 바뀌어 이전 결과를 재사용할 수 없습니다. 새로 실행해 주세요.', 409);
    const restored = restoreAppSteps(definition.value, saved.source_references ?? {}, message);
    if (!restored.ok) return reject(restored.message, 409);
    appResumeRecords = restored.records; appResumeFrom = saved.id;
  }

  const capabilitySettings = effectiveCapabilities(agent.capabilities, {
    tier: agent.tier,
    scope: agent.tier === 'official' ? { publicDataConnectors: new Set() } : await getCapabilityScope(actor.departmentId),
    knownConnectorIds: connectorCatalog().map((c) => c.id),
  });
  const capabilities = activeCapabilities(capabilitySettings);

  if (attachedImages.length > 0 && !capabilities.some((c) => c.acceptsImages)) {
    return reject('이 비서는 사진을 받지 않습니다. 사진 읽기를 켠 비서에서 물어 주세요.', 400);
  }

  // 대화를 만들기 전에 거른다 — 꺼진 비서에 파일을 보낸 요청으로 빈 대화가 생기지 않게
  const attachmentError = attachmentRequestError(attachment_ids, capabilities);
  if (attachmentError) return reject(attachmentError, 400);
  const sentIds: string[] = Array.isArray(attachment_ids) ? (attachment_ids as string[]) : [];
  if (appStepInputs) {
    if (sentIds.length && !definition.value?.attachments) return reject('이 앱은 파일 입력을 받지 않습니다.', 400);
    if (sentIds.length + libraryIds.length > APP_MAX_FILES) return reject(libraryIds.length ? '앱에는 올린 파일과 고른 문서를 합쳐 최대 3개까지 넣을 수 있습니다.' : '앱에는 파일을 최대 3개 첨부할 수 있습니다.', 400);
    if (definition.value?.attachments?.required && !sentIds.length && !libraryIds.length) return reject(definition.value.attachments.library ? '이 앱은 파일을 첨부하거나 문서함에서 문서를 골라야 합니다.' : '이 앱은 파일 첨부가 필요합니다.', 400);
  }

  const filterResult = await filterUserInput(actor.departmentId, message);
  if (!filterResult.isValid) {
    return reject('메시지에 금지된 내용이 포함되어 있습니다.', 400, {
      blockedWords: filterResult.blockedWords,
      blockedPatterns: filterResult.blockedPatterns,
    });
  }

  // 고른 문서를 대화를 만들기 전에 읽는다 — 거절될 요청으로 빈 대화가 쌓이지 않게. 그 앱 비서의 근거 판만(library-documents.ts)
  let libraryFiles: { name: string; extract: AttachmentExtract }[] = [];
  let libraryRefs: { id: string; title: string }[] = [];
  if (libraryIds.length) {
    const loaded = await loadLibraryDocuments(libraryIds, agent_id, actor, {
      async documentsOf(agentId, organizationId) {
        const { data: rows, error } = await supabaseAdmin
          .from('documents')
          .select(LIBRARY_DOCUMENT_COLUMNS)
          .eq('agent_id', agentId)
          .eq('organization_id', organizationId)
          .limit(1000);
        if (error) throw new Error(`문서 목록 조회 실패: ${error.message}`);
        return (rows ?? []) as unknown as LibraryDocumentRow[];
      },
      async download(path) {
        const { data: blob, error } = await supabaseAdmin.storage.from(SUPABASE_DOCUMENTS_BUCKET).download(path);
        if (error || !blob) return null;
        return new Uint8Array(await blob.arrayBuffer());
      },
    });
    if (!loaded.ok) return reject(loaded.message, loaded.status);
    libraryFiles = loaded.files;
    libraryRefs = loaded.refs;
  }

  // ── 능력 preflight ── 대화를 만들기 전에(판정 R4). 참고 문서를 불러오지 못하면 여기서 거절해
  // 빈 대화가 쌓이거나 새 대화의 첨부가 묶였다 지워지지 않게 한다
  const preflight: Partial<Record<CapabilityId, unknown>> = {};
  for (const cap of capabilities) {
    if (!cap.preflight) continue;
    const result = await cap.preflight({ organizationId: actor.organizationId, agentId: agent_id, message, skipDocuments });
    if (!result.ok) return reject(result.message, result.status, { code: result.code });
    if (result.carry !== undefined) preflight[cap.id] = result.carry;
  }

  // ── 대화 ──
  const isNewConversation = !(typeof conversation_id === 'string' && conversation_id);
  let conversationId: string;
  let history: Awaited<ReturnType<typeof loadHistory>> = [];
  if (!isNewConversation) {
    const { data: existing } = await supabaseAdmin
      .from('conversations')
      .select('id')
      .eq('id', conversation_id)
      .eq('user_id', actor.userId)
      .eq('agent_id', agent_id)
      .maybeSingle();
    if (!existing) return reject('대화를 찾을 수 없습니다.', 404);
    conversationId = existing.id;
    if (sentIds.length > 0) {
      const check = await checkAttachable(actor.userId, sentIds, conversationId);
      if (!check.ok) return reject(check.message, 400);
    }
    history = await loadHistory(conversationId);
  } else {
    // 묶을 수 없는 첨부면 대화를 만들기 전에 돌려보낸다 — 거절될 요청으로 빈 대화가 남지 않게
    if (sentIds.length > 0) {
      const check = await checkAttachable(actor.userId, sentIds, null);
      if (!check.ok) return reject(check.message, 400);
    }
    const { data: created, error } = await supabaseAdmin
      .from('conversations')
      .insert({
        department_id: actor.departmentId,
        agent_id,
        user_id: actor.userId,
        title: `대화 with ${agent.name}`,
      })
      .select('id')
      .single();
    if (error || !created) {
      console.error('[assistant] conversation insert error:', error);
      return reject(`대화 생성 실패: ${error?.message ?? '알 수 없는 오류'}`, 500);
    }
    conversationId = created.id;
  }

  // ── 첨부 ── 대화가 정해진 뒤에 묶는다(새 대화면 방금 만든 id로). bindAttachments가 주인을 다시 본다
  let attachments: TurnAttachment[] = [];
  if (capabilities.some((c) => c.acceptsFiles)) {
    let bound: AttachmentRecord[] = [];
    let newlyBound: string[] = [];
    if (sentIds.length > 0) {
      const result = await bindAttachments(actor.userId, conversationId, sentIds);
      if (!result.ok) {
        // 확인과 묶기 사이에 바뀌었다. 방금 만든 대화면 지운다 — 대화 삭제 라우트와 같은 순서(첨부 저장소 → 행)
        if (isNewConversation) await discardNewConversation(conversationId, actor.userId);
        return reject(result.message, 400);
      }
      bound = result.rows;
      newlyBound = result.newlyBound;
    }
    // 새 대화에 보낸 것도 없으면 붙은 첨부가 있을 수 없다 — 조회를 아낀다
    const listed =
      !isNewConversation || bound.length > 0
        ? await listConversationAttachments(actor.userId, conversationId, {
            onError: (msg) =>
              console.warn('[assistant] 첨부 목록을 읽지 못해 이번 턴은 방금 묶은 첨부만으로 진행합니다:', conversationId, msg),
          })
        : [];
    // 목록 조회가 실패하면 빈 배열이 온다. 방금 묶은 것만은 빠지지 않게 채워 넣는다
    const missing = bound.filter((b) => !listed.some((r) => r.id === b.id));
    attachments = toTurnAttachments([...listed, ...missing], newlyBound);
  }

  // ── 모델 ── 기관 허용 범위 안이면 비서의 모델, 아니면 허용 목록의 첫 번째
  const allowedModels = await getAllowedModelIds(actor.organizationId);
  const { modelId, substituted } = resolveModel(agent.model_id, allowedModels);
  if (substituted) {
    console.warn('[assistant] 비서 모델이 기관 허용 목록 밖이라 바꿈:', agent.model_id, '→', modelId);
  }

  const ctx: TurnContext = {
    organizationId: actor.organizationId,
    departmentId: actor.departmentId,
    userId: actor.userId,
    agentId: agent_id,
    agentVersion: agent.version,
    capabilities: capabilitySettings,
    message,
    conversationId,
    attachments,
    preflight,
    skipDocuments,
  };

  let fileContext = '';
  let appMaterialPieces: PreparedTurn['appMaterialPieces'];
  if (appStepInputs && (sentIds.length || libraryFiles.length)) {
    try {
      const selected = attachments.filter(a => sentIds.includes(a.id));
      if (selected.length !== new Set(sentIds).size) throw new Error('첨부 목록을 확인하지 못했습니다. 다시 첨부해 주세요.');
      // 올린 파일 다음에 문서함에서 고른 문서 — 같은 원자료 자리에 같은 규칙(읽기 경고·잘림 거절, 긴 자료는 나눠 추림)으로
      const material = appAttachmentMaterial([
        ...(await Promise.all(selected.map(async a => ({ name: a.fileName, extract: await loadTurnExtract(ctx, a) })))),
        ...libraryFiles,
      ]);
      // 긴 첨부는 조각으로 넘긴다 — 실행기(stream.ts)가 조각마다 추린 글을 사용자 메시지에 덧붙인다(모델 호출이라 여기서는 못 한다)
      if (material.context !== undefined) fileContext = material.context;
      else appMaterialPieces = { pieces: material.pieces, chars: material.chars };
      ctx.message = message + fileContext;
    } catch (failure) {
      if (isNewConversation) await discardNewConversation(conversationId, actor.userId);
      return reject(failure instanceof Error ? failure.message : '첨부 내용을 읽지 못했습니다.', 400, { attachments_consumed: isNewConversation });
    }
  }

  const prepared: PrepareResult[] = await Promise.all(
    capabilities.map((cap) => (cap.prepare ? cap.prepare(ctx) : Promise.resolve({} as PrepareResult)))
  );
  const chunks: RetrievedChunk[] = prepared.flatMap((p) => p.chunks ?? []);
  const dropped = prepared.find((p) => typeof p.dropped === 'number')?.dropped;
  // 근거와 보관함은 같은 능력의 결과에서 함께 꺼낸다 — 섞이면 다른 보관함에 근거를 보낸다
  const verifyFrom = prepared.find((p) => p.verifySources?.length);
  const verifySources = verifyFrom?.verifySources ?? [];
  const verifyTenant = verifyFrom?.verifyTenant ?? null;
  const { tools } = toolsFor(capabilities, ctx);

  return {
    ok: true,
    turn: {
      appSteps: body.app_inputs !== undefined ? definition.value?.steps : undefined,
      appStepInputs,
      appMaterialPieces,
      ...(libraryRefs.length ? { appDocuments: libraryRefs } : {}),
      appResumeRecords,
      appResumeFrom,
      ...(appDraftSavedAt ? { appDraftSavedAt } : {}),
      ctx,
      modelId,
      modelSubstituted: substituted,
      systemPrompt: buildSystemPrompt(agent.system_prompt, [...prepared.map((p) => p.systemAddendum), definition.value ? appOutputInstruction(definition.value) : undefined]),
      messages: [...history, { role: 'user', content: buildUserContent(message + fileContext, attachedImages) }],
      tools,
      capabilities,
      conversationId,
      isNewConversation,
      chunks,
      documentsSkipped: prepared.some((p) => p.documentsSkipped === true),
      docDropped: dropped ?? null,
      verifySources,
      verifyTenant,
      storedUserContent: storedUserContent(
        message,
        attachedImages.length,
        [...attachments.filter((a) => a.isNew).map((a) => a.fileName), ...libraryRefs.map((r) => `${r.title}(문서함)`)]
      ),
    },
  };
}
