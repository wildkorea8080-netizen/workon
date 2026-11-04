import { NextRequest, NextResponse } from 'next/server';
import { getServerAuthSession } from '@/lib/auth';
import { supabaseAdmin } from '@/lib/supabaseAdmin';
import { getActorScope } from '@/lib/actor-scope';
import { canEditAgent } from '@/lib/agent-permissions';
import { loadAgentAccess, saveAgentSettings, saveFailureResponse } from '@/lib/agent-store';
import { splitAgentBody, changedSettingKeys } from '@/lib/agent-patch';
import { jsonError, knownIds, checkCapabilityScope } from '@/lib/agent-route-helpers';
import { APP_DRAFT_KEYS, draftPatch, readAppDraft, type AppDraft } from '@/lib/apps/draft';

/**
 * 입력형 앱의 시험 판(0053) — 저장(PUT)·버리기(DELETE)·배포(POST). 모두 고칠 수 있는 사람(canEditAgent)만.
 *
 * - 저장: 빌더가 보내는 설정(이름·설명·분야·지시문·입력 설정·능력)을 검사해 `agents.app_draft`에 둔다. 지금 판은 그대로.
 *   기준 판이 지금 판과 같고, 불러온 시험 판(`draft_saved_at`, 없으면 null)이 그대로일 때만 바꾼다 — 두 사람이 서로의 시험 판을 덮지 않게.
 * - 배포: 시험 판을 다시 검사한 뒤 save_agent(판 번호·판 기록)로 올리고, 같은 시험 판일 때만 비운다. 그 사이 누가 배포했으면 409.
 * - 버리기: 불러온 시험 판일 때만 비운다.
 */

async function editable(id: string, session: Awaited<ReturnType<typeof getServerAuthSession>>) {
  if (!session?.user?.id) return { ok: false as const, error: jsonError('인증이 필요합니다.', 401) };
  const actor = await getActorScope(session);
  if (!actor) return { ok: false as const, error: jsonError('소속 부서가 지정되지 않았습니다. 기관 관리자에게 문의하세요.', 403) };
  const agent = await loadAgentAccess(id);
  if (!agent || agent.deleted_at) return { ok: false as const, error: jsonError('앱을 찾을 수 없습니다.', 404) };
  if (!canEditAgent(agent, actor)) return { ok: false as const, error: jsonError('이 앱을 고칠 권한이 없습니다.', 403) };
  return { ok: true as const, actor, agent };
}

const isoOrNull = (v: unknown) => (typeof v === 'string' && Number.isFinite(Date.parse(v)) ? v : v === null ? null : undefined);

/** 시험 판 저장 */
export async function PUT(request: NextRequest, { params }: { params: { id: string } }) {
  try {
    const found = await editable(params.id, await getServerAuthSession());
    if (!found.ok) return found.error;
    const { actor, agent } = found;
    const body = (await request.json().catch(() => null)) as Record<string, unknown> | null;
    if (!body || typeof body !== 'object') return jsonError('요청 형식이 올바르지 않습니다.', 400);
    const loaded = isoOrNull(body.draft_saved_at);
    if (loaded === undefined) return jsonError('draft_saved_at이 필요합니다(불러온 시험 판이 없으면 null).', 400);
    if (typeof body.base_version !== 'number') return jsonError('base_version이 필요합니다. 화면을 새로고침한 뒤 다시 시도해 주세요.', 400);

    const { data: row } = await supabaseAdmin.from('agents').select('agent_type').eq('id', params.id).single();
    if ((row as { agent_type?: string } | null)?.agent_type === 'link') return jsonError('외부 연결형 앱에는 시험 판을 둘 수 없습니다.', 400);

    // 시험 판에는 빌더 설정만 — 그 밖의 칸(모델·운영 값 등)은 받지 않는다
    const settingsBody = Object.fromEntries(APP_DRAFT_KEYS.filter((k) => body[k] !== undefined).map((k) => [k, body[k]]));
    const split = splitAgentBody(settingsBody, { currentType: 'chat', ...knownIds() });
    if (split.error) return jsonError(split.error, 400);
    if (!split.settings.app_definition) return jsonError('입력형 앱의 입력 설정이 필요합니다.', 400);
    if (!split.settings.name) return jsonError('앱 이름을 입력해 주세요.', 400);
    const scopeError = await checkCapabilityScope(agent.tier, split.settings.capabilities, actor.departmentId);
    if (scopeError) return jsonError(scopeError, 403);
    if (body.base_version !== agent.version) return jsonError('그 사이 앱이 새로 배포됐습니다. 앱을 새로 열어 바뀐 내용을 확인해 주세요.', 409);

    const draft: AppDraft = {
      settings: {
        name: split.settings.name,
        description: split.settings.description ?? null,
        category: split.settings.category ?? null,
        system_prompt: split.settings.system_prompt ?? null,
        app_definition: split.settings.app_definition,
        capabilities: (split.settings.capabilities ?? {}) as Record<string, unknown>,
      },
      base_version: agent.version,
      saved_by: actor.userId,
      saved_at: new Date().toISOString(),
    };
    let update = supabaseAdmin.from('agents').update({ app_draft: draft }).eq('id', params.id).eq('version', agent.version);
    update = loaded ? update.eq('app_draft->>saved_at', loaded) : update.is('app_draft', null);
    const { data: saved, error } = await update.select('id');
    if (error) return jsonError('시험 판을 저장하지 못했습니다.', 500);
    if (!saved?.length) return jsonError('다른 사람이 먼저 시험 판을 저장했거나 앱을 배포했습니다. 앱을 새로 열어 확인해 주세요.', 409);
    return NextResponse.json({ ok: true, data: { app_draft: draft } });
  } catch (error) {
    console.error('[app-draft PUT]', error);
    return jsonError('서버 오류가 발생했습니다.', 500);
  }
}

/** 시험 판 배포 — save_agent로 판을 올린다 */
export async function POST(request: NextRequest, { params }: { params: { id: string } }) {
  try {
    const found = await editable(params.id, await getServerAuthSession());
    if (!found.ok) return found.error;
    const { actor, agent } = found;
    const body = (await request.json().catch(() => null)) as Record<string, unknown> | null;
    const loaded = isoOrNull(body?.draft_saved_at);
    if (!loaded) return jsonError('배포할 시험 판(draft_saved_at)이 필요합니다.', 400);

    const { data: row } = await supabaseAdmin
      .from('agents')
      .select(`version, app_draft, ${APP_DRAFT_KEYS.join(', ')}`)
      .eq('id', params.id)
      .single();
    const current = (row ?? {}) as unknown as Record<string, unknown>;
    const draft = readAppDraft(current.app_draft);
    if (!draft || draft.saved_at !== loaded) return jsonError('배포할 시험 판이 바뀌었거나 없습니다. 앱을 새로 열어 확인해 주세요.', 409);
    if (draft.base_version !== current.version) return jsonError('시험 판을 만든 뒤 앱이 새로 배포됐습니다. 지금 판을 보고 시험 판을 다시 저장해 주세요.', 409);

    // 저장 때 검사했어도 그 사이 규칙(능력 범위·커넥터)이 바뀌었을 수 있어 다시 본다
    const split = splitAgentBody(draftPatch(draft) as Record<string, unknown>, { currentType: 'chat', ...knownIds() });
    if (split.error) return jsonError(split.error, 400);
    const scopeError = await checkCapabilityScope(agent.tier, split.settings.capabilities, actor.departmentId);
    if (scopeError) return jsonError(scopeError, 403);

    const changed = changedSettingKeys(current, split.settings);
    let version = draft.base_version;
    if (changed.length > 0) {
      const onlyChanged = Object.fromEntries(changed.map((key) => [key, split.settings[key as keyof typeof split.settings]]));
      const saved = await saveAgentSettings(params.id, draft.base_version, onlyChanged, actor.userId, 'settings', { from_draft: draft.saved_at });
      if (!saved.ok) {
        const failure = saveFailureResponse(saved);
        return jsonError(failure.message, failure.status, failure.details);
      }
      version = saved.version;
    }
    // 같은 시험 판일 때만 비운다(배포 직후 누가 새 시험 판을 저장했으면 그것은 남긴다)
    await supabaseAdmin.from('agents').update({ app_draft: null }).eq('id', params.id).eq('app_draft->>saved_at', draft.saved_at);
    const { data: agentRow } = await supabaseAdmin.from('agents').select('*').eq('id', params.id).single();
    return NextResponse.json({ ok: true, data: agentRow, meta: { version, changed } });
  } catch (error) {
    console.error('[app-draft POST]', error);
    return jsonError('서버 오류가 발생했습니다.', 500);
  }
}

/** 시험 판 버리기 — `?saved_at=`(불러온 시험 판)일 때만 */
export async function DELETE(request: NextRequest, { params }: { params: { id: string } }) {
  try {
    const found = await editable(params.id, await getServerAuthSession());
    if (!found.ok) return found.error;
    const loaded = isoOrNull(request.nextUrl.searchParams.get('saved_at'));
    if (!loaded) return jsonError('버릴 시험 판(saved_at)이 필요합니다.', 400);
    const { data, error } = await supabaseAdmin.from('agents').update({ app_draft: null }).eq('id', params.id).eq('app_draft->>saved_at', loaded).select('id');
    if (error) return jsonError('시험 판을 버리지 못했습니다.', 500);
    if (!data?.length) return jsonError('시험 판이 바뀌었거나 이미 없습니다. 앱을 새로 열어 확인해 주세요.', 409);
    return NextResponse.json({ ok: true, data: { app_draft: null } });
  } catch (error) {
    console.error('[app-draft DELETE]', error);
    return jsonError('서버 오류가 발생했습니다.', 500);
  }
}
