import { NextResponse } from 'next/server';
import { getServerAuthSession } from '@/lib/auth';
import { getActorScope } from '@/lib/actor-scope';
import { supabaseAdmin } from '@/lib/supabaseAdmin';
import { SUPABASE_DOCUMENTS_BUCKET } from '@/lib/config';
import { canReadDocument } from '@/lib/document-files';
import { loadAgentAccess } from '@/lib/agent-store';
import { canUseAgent } from '@/lib/agent-permissions';
import { defaultWorkContext, getWorkActor, handleWork, UNAUTHORIZED, NO_ACTOR } from '@/lib/work/server';
import { openEvidenceOriginal } from '@/lib/work/evidence-access';
import { WorkError } from '@/lib/work/types';
export const dynamic = 'force-dynamic';

export async function GET(_request: Request, { params }: { params: { id: string; documentId: string } }) {
  return handleWork(async () => {
    const session = await getServerAuthSession();
    if (!session?.user?.id) return UNAUTHORIZED();
    const ctx = defaultWorkContext();
    const actor = await getWorkActor(session, ctx);
    if (!actor) return NO_ACTOR();
    const scope = await getActorScope(session);
    if (!scope?.organizationId) return NO_ACTOR();
    const url = await openEvidenceOriginal(ctx, actor, params.id, params.documentId, async (id, agentId) => {
      const { data: doc, error } = await supabaseAdmin.from('documents').select('id, agent_id, organization_id, department_id, visibility, storage_path').eq('id', id).eq('organization_id', actor.organizationId).maybeSingle();
      if (error) throw new WorkError('SOURCE_UNAVAILABLE', '원문을 지금 불러올 수 없습니다.', 503);
      if (!doc || doc.agent_id !== agentId || !doc.storage_path || !canReadDocument(doc, scope)) throw new WorkError('NOT_FOUND', '원문을 찾을 수 없습니다.', 404);
      const agent = await loadAgentAccess(agentId);
      if (!agent || agent.tier !== 'official' || !agent.is_published || !canUseAgent(agent, scope)) throw new WorkError('NOT_FOUND', '원문을 찾을 수 없습니다.', 404);
      const { data, error: signingError } = await supabaseAdmin.storage.from(SUPABASE_DOCUMENTS_BUCKET).createSignedUrl(doc.storage_path, 60);
      if (signingError || !data?.signedUrl) throw new WorkError('STORAGE_FAILED', '원문을 지금 열 수 없습니다.', 503);
      return data.signedUrl;
    });
    return NextResponse.redirect(url, { status: 307, headers: { 'Cache-Control': 'private, no-store', 'Referrer-Policy': 'no-referrer' } });
  });
}
