import { NextRequest, NextResponse } from 'next/server';
import { getServerAuthSession } from '@/lib/auth';
import { callClaudeAPI } from '@/lib/claude';

export async function POST(request: NextRequest) {
  try {
    const session = await getServerAuthSession();
    if (!session?.user?.id) {
      return NextResponse.json(
        { ok: false, error: { message: '인증이 필요합니다.' } },
        { status: 401 }
      );
    }

    const body = await request.json();
    const { prompt, type } = body;

    if (!prompt || typeof prompt !== 'string' || prompt.trim().length === 0) {
      return NextResponse.json(
        { ok: false, error: { message: '프롬프트를 입력해주세요.' } },
        { status: 400 }
      );
    }

    if (type !== 'agent' && type !== 'chat') {
      return NextResponse.json(
        { ok: false, error: { message: 'type은 "agent" 또는 "chat"이어야 합니다.' } },
        { status: 400 }
      );
    }

    const userMessage =
      type === 'agent'
        ? `다음은 AI 비서의 역할 설명 초안입니다.
이것을 더 전문적이고 효과적인 시스템 프롬프트로 확장해줘.
- 한국어로 작성
- 3~5문장 분량
- 구체적인 행동 지침 포함
- 출력 형식 지침 포함
- 원래 의도 유지

초안: ${prompt.trim()}

시스템 프롬프트만 출력하고 다른 설명은 하지마.`
        : `다음 질문을 AI가 더 정확하게 이해할 수 있도록
구체적이고 명확하게 다듬어줘.
한국어로, 원래 의도 유지.
개선된 질문만 출력:

원본: ${prompt.trim()}`;

    const result = await callClaudeAPI(
      [{ role: 'user', content: userMessage }],
      undefined,
      512
    );

    return NextResponse.json({
      ok: true,
      data: { enhancedPrompt: result.content.trim() },
    });
  } catch (error) {
    console.error('[enhance-prompt] 오류:', error);
    return NextResponse.json(
      { ok: false, error: { message: '프롬프트 개선에 실패했습니다.' } },
      { status: 500 }
    );
  }
}
