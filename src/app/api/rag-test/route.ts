import { NextRequest, NextResponse } from 'next/server';
import { getServerAuthSession, isAdminSession } from '@/lib/auth';
import { getActorScope } from '@/lib/actor-scope';
import { loadAgentAccess } from '@/lib/agent-store';
import { searchAgentDocuments, DOCUMENTS_UNAVAILABLE_MESSAGE } from '@/lib/capabilities/doc-search';
import { NodaError } from '@/lib/noda';
import type { ApiResponse } from '@/lib/db';

/**
 * 관리자 문서 찾기 시험. 대화와 같은 규칙(NODA /context, 하한 0.80, 이 비서 행과 맞춤)으로 찾는다.
 * 요청자 기관의 비서만 — 다른 기관 비서 id를 넣어 그 문서를 엿보지 못하게 한다(기관이 다르면 없는 것처럼 404).
 */
export async function POST(request: NextRequest) {
  try {
    const session = await getServerAuthSession();

    if (!isAdminSession(session)) {
      return NextResponse.json<ApiResponse<null>>(
        { ok: false, error: { message: '관리자 권한이 필요합니다.' } },
        { status: 403 }
      );
    }

    const body = await request.json().catch(() => ({}));
    const { agentId, query } = body as { agentId?: unknown; query?: unknown };

    if (typeof agentId !== 'string' || !agentId || typeof query !== 'string' || !query.trim()) {
      return NextResponse.json<ApiResponse<null>>(
        { ok: false, error: { message: '에이전트 ID와 검색어가 필요합니다.' } },
        { status: 400 }
      );
    }

    const actor = await getActorScope(session!);
    if (!actor || !actor.organizationId) {
      return NextResponse.json<ApiResponse<null>>(
        { ok: false, error: { message: '소속 부서가 지정되지 않았습니다.' } },
        { status: 403 }
      );
    }

    const agent = await loadAgentAccess(agentId);
    if (!agent || agent.deleted_at || agent.organization_id !== actor.organizationId) {
      return NextResponse.json<ApiResponse<null>>(
        { ok: false, error: { message: '비서를 찾을 수 없습니다.' } },
        { status: 404 }
      );
    }

    const result = await searchAgentDocuments(agent.id, query);

    return NextResponse.json(
      {
        ok: true,
        data: {
          chunks: result.chunks,
          dropped: result.dropped,
          query,
          agentId: agent.id,
          timestamp: new Date().toISOString(),
        },
      },
      { status: 200 }
    );
  } catch (error) {
    if (error instanceof NodaError) {
      console.error('[RAG-TEST] NODA 오류:', error.code, error.status);
      return NextResponse.json<ApiResponse<null>>(
        { ok: false, error: { message: DOCUMENTS_UNAVAILABLE_MESSAGE } },
        { status: 503 }
      );
    }
    console.error('[RAG-TEST] 오류:', error);
    return NextResponse.json<ApiResponse<null>>(
      { ok: false, error: { message: '검색 중 오류가 발생했습니다.' } },
      { status: 500 }
    );
  }
}
