import { NextRequest, NextResponse } from 'next/server';
import { getServerAuthSession, isAdminSession } from '@/lib/auth';
import { getActorScope } from '@/lib/actor-scope';
import { loadAgentAccess } from '@/lib/agent-store';
import { searchLikeChat, DOCUMENTS_UNAVAILABLE_MESSAGE } from '@/lib/capabilities/doc-search';
import { NodaError } from '@/lib/noda';
import type { ApiResponse } from '@/lib/db';

/**
 * 관리자 문서 찾기 시험. **대화와 똑같이** 찾는다(`searchLikeChat` — 비서 보관함 + 기관 유형의 공통 자료실, 예산 나누기·번호 밀기·
 * 섞임·고아·판·시행일 규칙까지, 2026-11-05). 예전에는 비서 보관함만 찾아, 대화는 공통 기준으로 답하는데 시험은 '근거 없음'이었다.
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

    // 기관 id는 요청자 기관(= 비서의 기관) — 섞임(critical) 운영 기록이 어느 기관의 일인지 남고, 공통 자료실 유형도 이 기관으로 읽는다
    const chunks = await searchLikeChat({ agentId: agent.id, organizationId: actor.organizationId, query });
    // 대화라면 '참고 문서를 지금 불러오지 못했습니다'로 거절할 때(비서·공통 보관함 하나라도 NODA 실패, 문서 행 조회 실패)
    if (chunks === null) {
      return NextResponse.json<ApiResponse<null>>(
        { ok: false, error: { message: DOCUMENTS_UNAVAILABLE_MESSAGE } },
        { status: 503 }
      );
    }

    return NextResponse.json(
      {
        ok: true,
        data: {
          chunks,
          query,
          agentId: agent.id,
          timestamp: new Date().toISOString(),
        },
      },
      { status: 200 }
    );
  } catch (error) {
    if (error instanceof NodaError) {
      console.error('[RAG-TEST] NODA 오류:', error.code, error.status, error.requestId ?? '');
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
