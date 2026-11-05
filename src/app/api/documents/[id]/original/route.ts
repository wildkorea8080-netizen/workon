import { NextRequest, NextResponse } from 'next/server';
import { getServerAuthSession } from '@/lib/auth';
import { getActorScope } from '@/lib/actor-scope';
import { supabaseAdmin } from '@/lib/supabaseAdmin';
import { loadAgentAccess } from '@/lib/agent-store';
import { AGENT_ORIGINAL_COLUMNS, canOpenAgentOriginal, originalUrl, parsePage, signOriginal, type AgentOriginalDoc } from '@/lib/source-original';

export const dynamic = 'force-dynamic';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const NOT_FOUND = '원본을 찾을 수 없습니다.';

function jsonError(message: string, status: number) {
  return NextResponse.json({ ok: false, error: { message } }, { status });
}

/**
 * 대화 근거 창의 '원본 열기' — 비서 문서의 저장소 원본을 60초 서명 주소로 307.
 * 그 문서를 볼 수 있고(문서 목록과 같은 공개 범위) 그 문서의 비서를 지금 쓸 수 있는 사람만. 남의 것·없는 것은 똑같이 404.
 * `?page=N`이면 PDF는 그 쪽으로 연다.
 */
export async function GET(request: NextRequest, { params }: { params: { id: string } }) {
  const session = await getServerAuthSession();
  if (!session?.user?.id) return jsonError('인증이 필요합니다.', 401);
  if (!UUID.test(params.id)) return jsonError(NOT_FOUND, 404);
  const actor = await getActorScope(session);
  if (!actor?.organizationId) return jsonError(NOT_FOUND, 404);

  const { data, error } = await supabaseAdmin
    .from('documents')
    .select(AGENT_ORIGINAL_COLUMNS)
    .eq('id', params.id.toLowerCase())
    .eq('organization_id', actor.organizationId)
    .maybeSingle();
  if (error) return jsonError('원본을 지금 불러올 수 없습니다. 잠시 뒤 다시 시도해 주세요.', 503);
  const doc = (data ?? null) as AgentOriginalDoc | null;
  const agent = doc?.agent_id ? await loadAgentAccess(doc.agent_id) : null;
  if (!doc || !canOpenAgentOriginal(doc, agent, actor)) return jsonError(NOT_FOUND, 404);

  const signed = await signOriginal(doc.storage_path!);
  if (!signed) return jsonError('원본을 지금 열 수 없습니다. 잠시 뒤 다시 시도해 주세요.', 503);
  const url = originalUrl(signed, doc.file_name, doc.file_type, parsePage(request.nextUrl.searchParams.get('page')));
  return NextResponse.redirect(url, { status: 307, headers: { 'Cache-Control': 'private, no-store', 'Referrer-Policy': 'no-referrer' } });
}
