import { NextRequest, NextResponse } from 'next/server';
import { getServerAuthSession, isAdminSession } from '@/lib/auth';
import { retrieveRelevantChunks } from '@/lib/rag';
import type { ApiResponse } from '@/lib/db';

export async function POST(request: NextRequest) {
  try {
    const session = await getServerAuthSession();
    
    if (!isAdminSession(session)) {
      return NextResponse.json<ApiResponse<null>>(
        { ok: false, error: { message: '관리자 권한이 필요합니다.' } },
        { status: 403 }
      );
    }

    const body = await request.json();
    const { agentId, query } = body;

    if (!agentId || !query) {
      return NextResponse.json<ApiResponse<null>>(
        { ok: false, error: { message: '에이전트 ID와 검색어가 필요합니다.' } },
        { status: 400 }
      );
    }

    // RAG 검색 실행
    const result = await retrieveRelevantChunks(agentId, query);

    return NextResponse.json<ApiResponse<any>>(
      {
        ok: true,
        data: {
          chunks: result.chunks,
          query: query,
          agentId: agentId,
          timestamp: new Date().toISOString(),
        },
      },
      { status: 200 }
    );
  } catch (error) {
    console.error('[RAG-TEST] 오류:', error);
    return NextResponse.json<ApiResponse<null>>(
      {
        ok: false,
        error: {
          message: '검색 중 오류가 발생했습니다.',
          details: error instanceof Error ? error.message : '알 수 없는 오류',
        },
      },
      { status: 500 }
    );
  }
}
