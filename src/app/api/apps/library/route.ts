import { NextRequest, NextResponse } from 'next/server';
import { getServerAuthSession } from '@/lib/auth';
import { getActorScope } from '@/lib/actor-scope';
import { supabaseAdmin } from '@/lib/supabaseAdmin';
import { AGENT_ACCESS_COLUMNS, canEditAgent, canUseAgent, type AgentAccessInfo } from '@/lib/agent-permissions';
import { validateAppDefinition } from '@/lib/apps/definition';
import { readAppDraft } from '@/lib/apps/draft';
import { LIBRARY_DOCUMENT_COLUMNS, libraryOption, selectableLibraryDocuments, type LibraryDocumentRow } from '@/lib/apps/library-documents';

export const dynamic = 'force-dynamic';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function jsonError(message: string, status: number) {
  return NextResponse.json({ ok: false, error: { message } }, { status });
}

/**
 * 입력형 앱 실행 화면의 '문서함에서 고르기' 목록(2026-11-05) — `GET ?agentId=`.
 * 그 앱을 쓸 수 있는 직원에게, 앱이 문서 고르기를 허용할 때만(시험 판은 고칠 수 있는 사람만), 고를 수 있는 문서(이 비서의
 * 읽힌 현재 판·볼 수 있는 것·판과 시행일 규칙상 근거인 것)의 id·이름·형식·시행일만 준다. 저장소 경로는 싣지 않는다.
 * 실제 제한은 실행(`/api/chat`의 `app_document_ids`)에서 다시 건다.
 */
export async function GET(request: NextRequest) {
  try {
    const session = await getServerAuthSession();
    if (!session?.user?.id) return jsonError('로그인이 필요합니다.', 401);
    const actor = await getActorScope(session);
    if (!actor?.organizationId) return jsonError('소속 기관을 확인할 수 없습니다.', 403);

    const agentId = request.nextUrl.searchParams.get('agentId');
    if (!agentId || !UUID.test(agentId)) return jsonError('앱을 찾을 수 없습니다.', 404);
    const { data: agent, error } = await supabaseAdmin
      .from('agents')
      .select(`${AGENT_ACCESS_COLUMNS}, app_definition, app_draft`)
      .eq('id', agentId)
      .maybeSingle();
    if (error) return jsonError('앱을 불러오지 못했습니다.', 500);
    const row = agent as (AgentAccessInfo & { app_definition: unknown; app_draft: unknown }) | null;
    if (!row || row.deleted_at || !row.is_active || !canUseAgent(row, actor)) return jsonError('앱을 찾을 수 없습니다.', 404);

    const current = validateAppDefinition(row.app_definition ?? null);
    const draft = canEditAgent(row, actor) ? readAppDraft(row.app_draft) : null;
    const allowed = (current.ok && current.value?.attachments?.library === true) || draft?.settings.app_definition.attachments?.library === true;
    if (!allowed) return jsonError('이 앱은 문서함에서 문서를 고를 수 없습니다.', 400);

    const { data: docs, error: docError } = await supabaseAdmin
      .from('documents')
      .select(LIBRARY_DOCUMENT_COLUMNS)
      .eq('agent_id', row.id)
      .eq('organization_id', actor.organizationId)
      .limit(1000);
    if (docError) return jsonError('문서 목록을 불러오지 못했습니다.', 500);
    const options = selectableLibraryDocuments((docs ?? []) as unknown as LibraryDocumentRow[], row.id, actor)
      .map(libraryOption)
      .sort((a, b) => a.title.localeCompare(b.title, 'ko'));
    return NextResponse.json({ ok: true, data: options });
  } catch (error) {
    console.error('[apps library]', error);
    return jsonError('문서 목록을 불러오지 못했습니다.', 500);
  }
}
