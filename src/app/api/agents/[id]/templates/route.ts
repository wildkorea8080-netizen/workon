// src/app/api/agents/[id]/templates/route.ts
import { NextRequest, NextResponse } from 'next/server';
import { randomUUID } from 'crypto';
import { getServerAuthSession } from '@/lib/auth';
import { supabaseAdmin } from '@/lib/supabaseAdmin';
import { getActorScope } from '@/lib/actor-scope';
import { canEditAgent } from '@/lib/agent-permissions';
import { loadAgentAccess, saveAgentSettings, saveFailureResponse } from '@/lib/agent-store';
import { jsonError } from '@/lib/agent-route-helpers';
import { parseBaseVersion } from '@/lib/agent-patch';
import { validateTemplateFile, templateStoragePath, MAX_TEMPLATES } from '@/lib/template-files';
import { SUPABASE_DOCUMENTS_BUCKET } from '@/lib/config';

async function activeTemplates(agentId: string) {
  const { data } = await supabaseAdmin
    .from('agent_templates')
    .select('id, name, file_name, size_bytes, created_at')
    .eq('agent_id', agentId)
    .is('retired_at', null)
    .order('created_at', { ascending: true });
  return (data ?? []) as { id: string; name: string; file_name: string; size_bytes: number; created_at: string }[];
}

export async function GET(_request: NextRequest, { params }: { params: { id: string } }) {
  try {
    const session = await getServerAuthSession();
    if (!session?.user?.id) return jsonError('인증이 필요합니다.', 401);

    const actor = await getActorScope(session);
    if (!actor) return jsonError('소속 부서가 지정되지 않았습니다.', 403);

    const agent = await loadAgentAccess(params.id);
    if (!agent || agent.deleted_at) return jsonError('비서를 찾을 수 없습니다.', 404);
    if (!canEditAgent(agent, actor)) return jsonError('양식을 볼 권한이 없습니다.', 403);

    return NextResponse.json({ ok: true, data: { version: agent.version, items: await activeTemplates(params.id) } });
  } catch (error) {
    console.error('[agent templates GET]', error);
    return jsonError('서버 오류가 발생했습니다.', 500);
  }
}

/**
 * 양식 추가. 행은 꺼진 채로 넣고(0026 기본값), save_agent가 판을 올리며
 * 켠다. 판이 어긋나 저장이 거절되면 꺼진 행과 파일만 남는다 — 아무에게도
 * 보이지 않으므로 해가 없다.
 */
export async function POST(request: NextRequest, { params }: { params: { id: string } }) {
  try {
    const session = await getServerAuthSession();
    if (!session?.user?.id) return jsonError('인증이 필요합니다.', 401);

    const actor = await getActorScope(session);
    if (!actor) return jsonError('소속 부서가 지정되지 않았습니다.', 403);

    const agent = await loadAgentAccess(params.id);
    if (!agent || agent.deleted_at) return jsonError('비서를 찾을 수 없습니다.', 404);
    if (!canEditAgent(agent, actor)) return jsonError('양식을 올릴 권한이 없습니다.', 403);

    const form = await request.formData();
    const file = form.get('file');
    const name = String(form.get('name') ?? '').trim();
    // 판 번호는 파일을 올리기 전에 본다. 뒤에서 거절하면 꺼진 행과 파일만 남는다.
    const baseVersion = parseBaseVersion(form.get('base_version'));

    if (baseVersion === null) return jsonError('base_version이 필요합니다.', 400);
    if (!(file instanceof File)) return jsonError('양식 파일이 필요합니다.', 400);
    if (!name || name.length > 60) return jsonError('양식 이름은 1~60자로 입력해 주세요.', 400);

    const fileError = validateTemplateFile(file.name, file.size);
    if (fileError) return jsonError(fileError, 400);

    const current = await activeTemplates(params.id);
    if (current.length >= MAX_TEMPLATES) return jsonError(`양식은 비서당 ${MAX_TEMPLATES}개까지입니다.`, 400);

    const fileId = randomUUID();
    const storagePath = templateStoragePath(agent.organization_id ?? 'none', params.id, fileId, file.name);
    const { error: uploadError } = await supabaseAdmin.storage
      .from(SUPABASE_DOCUMENTS_BUCKET)
      .upload(storagePath, Buffer.from(await file.arrayBuffer()), {
        contentType: file.type || 'application/octet-stream',
        upsert: false,
      });
    if (uploadError) return jsonError('양식 파일 저장에 실패했습니다.', 500);

    const { error: insertError } = await supabaseAdmin.from('agent_templates').insert({
      id: fileId,
      agent_id: params.id,
      name,
      storage_path: storagePath,
      file_name: file.name,
      mime_type: file.type || null,
      size_bytes: file.size,
      created_by: actor.userId,
    });
    if (insertError) return jsonError('양식 등록에 실패했습니다.', 500);

    const saved = await saveAgentSettings(
      params.id,
      baseVersion,
      { template_ids: [...current.map((t) => t.id), fileId] },
      actor.userId,
      'settings',
      { template_added: name }
    );
    if (!saved.ok) {
      const failure = saveFailureResponse(saved);
      return jsonError(failure.message, failure.status, failure.details);
    }

    return NextResponse.json({ ok: true, data: { version: saved.version, id: fileId } }, { status: 201 });
  } catch (error) {
    console.error('[agent templates POST]', error);
    return jsonError('서버 오류가 발생했습니다.', 500);
  }
}
