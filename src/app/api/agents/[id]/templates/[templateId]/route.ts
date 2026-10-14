// src/app/api/agents/[id]/templates/[templateId]/route.ts
import { NextRequest, NextResponse } from 'next/server';
import { getServerAuthSession } from '@/lib/auth';
import { supabaseAdmin } from '@/lib/supabaseAdmin';
import { getActorScope } from '@/lib/actor-scope';
import { canEditAgent } from '@/lib/agent-permissions';
import { loadAgentAccess, saveAgentSettings, saveFailureResponse } from '@/lib/agent-store';
import { jsonError } from '@/lib/agent-route-helpers';
import { parseBaseVersion } from '@/lib/agent-patch';

/** 양식 빼기. 행과 파일은 남긴다 — 판을 되돌리면 다시 살아난다. */
export async function DELETE(request: NextRequest, { params }: { params: { id: string; templateId: string } }) {
  try {
    const session = await getServerAuthSession();
    if (!session?.user?.id) return jsonError('인증이 필요합니다.', 401);

    const actor = await getActorScope(session);
    if (!actor) return jsonError('소속 부서가 지정되지 않았습니다.', 403);

    const agent = await loadAgentAccess(params.id);
    if (!agent || agent.deleted_at) return jsonError('비서를 찾을 수 없습니다.', 404);
    if (!canEditAgent(agent, actor)) return jsonError('양식을 뺄 권한이 없습니다.', 403);

    const baseVersion = parseBaseVersion(new URL(request.url).searchParams.get('base_version'));
    if (baseVersion === null) return jsonError('base_version이 필요합니다.', 400);

    const { data } = await supabaseAdmin
      .from('agent_templates')
      .select('id, name')
      .eq('agent_id', params.id)
      .is('retired_at', null);
    const active = (data ?? []) as { id: string; name: string }[];
    const target = active.find((t) => t.id === params.templateId);
    if (!target) return jsonError('양식을 찾을 수 없습니다.', 404);

    const saved = await saveAgentSettings(
      params.id,
      baseVersion,
      { template_ids: active.filter((t) => t.id !== params.templateId).map((t) => t.id) },
      actor.userId,
      'settings',
      { template_removed: target.name }
    );
    if (!saved.ok) {
      const failure = saveFailureResponse(saved);
      return jsonError(failure.message, failure.status, failure.details);
    }
    return NextResponse.json({ ok: true, data: { version: saved.version } });
  } catch (error) {
    console.error('[agent template DELETE]', error);
    return jsonError('서버 오류가 발생했습니다.', 500);
  }
}
