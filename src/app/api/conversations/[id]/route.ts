import { NextRequest, NextResponse } from 'next/server';
import { getServerAuthSession } from '@/lib/auth';
import { supabaseAdmin } from '@/lib/supabaseAdmin';
import { deleteConversationFiles } from '@/lib/generated-files';
import { deleteConversationAttachments } from '@/lib/attachments/store';
import { loadConversationFeedback } from '@/lib/message-feedback';
import { cleanConversationTitle, MAX_CONVERSATION_TITLE } from '@/lib/conversation-title';

// .single()이 '행 없음'일 때 주는 코드 — 그 밖의 오류는 못 읽은 것이다(2026-11-19)
const NO_ROW = 'PGRST116';
const READ_FAILED = '대화를 지금 읽지 못했습니다. 잠시 뒤 다시 열어 주세요.';

export async function GET(
  request: NextRequest,
  { params }: { params: { id: string } }
) {
  try {
    const session = await getServerAuthSession();
    if (!session?.user?.id) {
      return NextResponse.json(
        { ok: false, error: { message: '인증이 필요합니다.' } },
        { status: 401 }
      );
    }

    const conversationId = params.id;

    // 대화 상세 조회 (사용자 권한 확인 포함)
    const { data: conversation, error } = await supabaseAdmin
      .from('conversations')
      .select(`
        id,
        title,
        agent_id,
        created_at,
        updated_at,
        agent:agents(id, name, description, icon, color, system_prompt, tier, category, capabilities, model_id, app_definition),
        messages(
          id,
          role,
          content,
          source_references,
          agent_version,
          created_at
        )
      `)
      .order('created_at', { referencedTable: 'messages', ascending: true })
      // 한 턴의 질문·답은 시각이 같다 — 같으면 질문(user)이 먼저(2026-11-18, history.ts 참고)
      .order('role', { referencedTable: 'messages', ascending: false })
      .eq('id', conversationId)
      .eq('user_id', session.user.id)
      .single();

    if (error) {
      if (error.code === NO_ROW) {
        return NextResponse.json(
          { ok: false, error: { message: '대화를 찾을 수 없습니다.' } },
          { status: 404 }
        );
      }
      // 못 읽은 것을 '없음'으로 답하지 않는다(2026-11-19)
      console.error('대화 상세 조회 오류:', error);
      return NextResponse.json({ ok: false, error: { message: READ_FAILED } }, { status: 503 });
    }

    // 내가 남긴 답변 평가(0064) — 못 읽으면 빈 값(대화는 그대로 연다)
    const feedback = await loadConversationFeedback(session.user.id, conversationId);
    return NextResponse.json({ ok: true, data: { ...conversation, feedback } });
  } catch (error) {
    console.error('대화 상세 조회 중 오류:', error);
    return NextResponse.json(
      { ok: false, error: { message: '오류가 발생했습니다.' } },
      { status: 500 }
    );
  }
}

export async function PUT(
  request: NextRequest,
  { params }: { params: { id: string } }
) {
  try {
    const session = await getServerAuthSession();
    if (!session?.user?.id) {
      return NextResponse.json(
        { ok: false, error: { message: '인증이 필요합니다.' } },
        { status: 401 }
      );
    }

    const conversationId = params.id;
    const body = await request.json().catch(() => null);
    // 글이 아니거나 비었거나 너무 긴 이름은 받지 않는다 — 사이드바·공개 공유 화면에 그대로 실린다(2026-11-19)
    const title = cleanConversationTitle((body as { title?: unknown } | null)?.title);
    if (!title) {
      return NextResponse.json(
        { ok: false, error: { message: `대화 이름은 1~${MAX_CONVERSATION_TITLE}자로 적어 주세요.` } },
        { status: 400 }
      );
    }

    // 대화 제목 업데이트 (사용자 권한 확인 포함) — 행이 없으면 404, 쓰기 실패는 500
    const { data: conversation, error } = await supabaseAdmin
      .from('conversations')
      .update({ title, updated_at: new Date().toISOString() })
      .eq('id', conversationId)
      .eq('user_id', session.user.id)
      .select('id, title, updated_at')
      .maybeSingle();

    if (error) {
      console.error('대화 업데이트 오류:', error);
      return NextResponse.json(
        { ok: false, error: { message: '대화 이름을 바꾸지 못했습니다. 잠시 뒤 다시 시도해 주세요.' } },
        { status: 500 }
      );
    }
    if (!conversation) {
      return NextResponse.json(
        { ok: false, error: { message: '대화를 찾을 수 없습니다.' } },
        { status: 404 }
      );
    }

    return NextResponse.json({ ok: true, data: conversation });
  } catch (error) {
    console.error('대화 업데이트 중 오류:', error);
    return NextResponse.json(
      { ok: false, error: { message: '오류가 발생했습니다.' } },
      { status: 500 }
    );
  }
}

export async function DELETE(
  request: NextRequest,
  { params }: { params: { id: string } }
) {
  try {
    const session = await getServerAuthSession();
    if (!session?.user?.id) {
      return NextResponse.json(
        { ok: false, error: { message: '인증이 필요합니다.' } },
        { status: 401 }
      );
    }

    const conversationId = params.id;

    // 소유자 확인
    const { data: existing, error: existingError } = await supabaseAdmin
      .from('conversations')
      .select('id')
      .eq('id', conversationId)
      .eq('user_id', session.user.id)
      .maybeSingle();

    if (existingError) {
      console.error('대화 삭제 전 조회 오류:', existingError);
      return NextResponse.json({ ok: false, error: { message: READ_FAILED } }, { status: 503 });
    }
    if (!existing) {
      return NextResponse.json(
        { ok: false, error: { message: '대화를 찾을 수 없습니다.' } },
        { status: 404 }
      );
    }

    // 대화가 만든 파일을 저장소에서 먼저 지운다. DB 연쇄 삭제는 저장소를 지우지 않는다(설계 5.4)
    await deleteConversationFiles(conversationId);
    // 첨부 원본·읽은 내용도 같은 이유로 먼저 지운다(S3 설계 4.7)
    await deleteConversationAttachments(conversationId);

    // 메시지 먼저 삭제 (cascade 미설정 대비)
    await supabaseAdmin.from('messages').delete().eq('conversation_id', conversationId);

    const { error } = await supabaseAdmin
      .from('conversations')
      .delete()
      .eq('id', conversationId)
      .eq('user_id', session.user.id);

    if (error) {
      console.error('대화 삭제 오류:', error);
      return NextResponse.json(
        { ok: false, error: { message: '대화를 삭제할 수 없습니다.' } },
        { status: 500 }
      );
    }

    return NextResponse.json({ ok: true, data: { message: '대화가 삭제되었습니다.' } });
  } catch (error) {
    console.error('대화 삭제 중 오류:', error);
    return NextResponse.json(
      { ok: false, error: { message: '오류가 발생했습니다.' } },
      { status: 500 }
    );
  }
}
