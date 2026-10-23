import { NextRequest, NextResponse } from 'next/server';
import { getServerAuthSession } from '@/lib/auth';
import { getActorScope } from '@/lib/actor-scope';
import { supabaseAdmin } from '@/lib/supabaseAdmin';
import { canEditAgent } from '@/lib/agent-permissions';
import { loadAgentAccess } from '@/lib/agent-store';
import { canReadDocument } from '@/lib/document-files';
import { readDocument } from '@/lib/document-reading';

export const dynamic = 'force-dynamic';
// NODA 업로드는 읽기를 끝내고 응답한다 — 한 번에 최대 5분(300,000ms)
export const maxDuration = 300;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function jsonError(message: string, status: number) {
  return NextResponse.json({ ok: false, error: { message } }, { status });
}

/**
 * 한 문서를 NODA로 읽힌다. 확인 직후 화면이 걸고, 문서 목록이 `kick: true`로 알려 준 멈춘 행도 이 길로 다시 건다.
 * `retry: true`는 읽기에 실패한 문서(`failed`)를 다시 시작하는 것이라 그 비서를 고칠 수 있는 사람만 한다.
 * 같은 문서가 동시에 걸려도 NODA 업로드는 한 번이다(readDocument의 조건부 갱신).
 */
export async function POST(request: NextRequest, { params }: { params: { id: string } }) {
  try {
    const session = await getServerAuthSession();
    if (!session?.user?.id) return jsonError('로그인이 필요합니다.', 401);

    const actor = await getActorScope(session);
    if (!actor?.organizationId) return jsonError('소속 기관을 확인할 수 없습니다.', 403);

    if (!UUID.test(params.id)) return jsonError('문서를 찾을 수 없습니다.', 404);

    let retry = false;
    try {
      const body = await request.json();
      retry = body?.retry === true;
    } catch {
      // 본문이 없으면 그냥 읽기다
    }

    // 요청자 기관으로 한정해 읽는다 — 다른 기관 문서는 있는지도 알려 주지 않는다
    const { data: doc, error } = await supabaseAdmin
      .from('documents')
      .select('id, agent_id, department_id, organization_id, visibility')
      .eq('id', params.id)
      .eq('organization_id', actor.organizationId)
      .maybeSingle();
    if (error) {
      console.error('[documents read] 문서 조회 실패:', error.message);
      return jsonError('문서를 불러오지 못했습니다.', 500);
    }
    if (!doc || !canReadDocument(doc, actor)) return jsonError('문서를 찾을 수 없습니다.', 404);

    if (retry) {
      const agent = doc.agent_id ? await loadAgentAccess(doc.agent_id) : null;
      if (!agent || !canEditAgent(agent, actor)) {
        return jsonError('이 문서를 다시 읽힐 권한이 없습니다.', 403);
      }
    }

    const outcome = await readDocument(params.id, { retry });
    if (outcome.status === 'not_found') return jsonError('문서를 찾을 수 없습니다.', 404);
    return NextResponse.json({ ok: true, data: outcome });
  } catch (error) {
    console.error('[documents read]', error);
    return jsonError('문서를 읽는 중 오류가 발생했습니다.', 500);
  }
}
