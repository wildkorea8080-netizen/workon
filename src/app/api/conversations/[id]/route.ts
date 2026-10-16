import { NextRequest, NextResponse } from 'next/server';
import { getServerAuthSession } from '@/lib/auth';
import { supabaseAdmin } from '@/lib/supabaseAdmin';
import { deleteConversationFiles } from '@/lib/generated-files';
import { deleteConversationAttachments } from '@/lib/attachments/store';

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
        agent:agents(id, name, description, icon, color, system_prompt, tier, category, capabilities, model_id),
        messages(
          id,
          role,
          content,
          source_references,
          created_at
        )
      `)
      .order('created_at', { referencedTable: 'messages', ascending: true })
      .eq('id', conversationId)
      .eq('user_id', session.user.id)
      .single();

    if (error) {
      console.error('대화 상세 조회 오류:', error);
      return NextResponse.json(
        { ok: false, error: { message: '대화를 찾을 수 없습니다.' } },
        { status: 404 }
      );
    }

    return NextResponse.json({ ok: true, data: conversation });
  } catch (error) {
    console.error('대화 상세 조회 중 오류:', error);
    return NextResponse.json(
      { ok: false, error: { message: '오류가 발생했습니다.', details: error } },
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
    const body = await request.json();
    const { title } = body;

    if (!title) {
      return NextResponse.json(
        { ok: false, error: { message: '제목이 필요합니다.' } },
        { status: 400 }
      );
    }

    // 대화 제목 업데이트 (사용자 권한 확인 포함)
    const { data: conversation, error } = await supabaseAdmin
      .from('conversations')
      .update({ title, updated_at: new Date().toISOString() })
      .eq('id', conversationId)
      .eq('user_id', session.user.id)
      .select()
      .single();

    if (error) {
      console.error('대화 업데이트 오류:', error);
      return NextResponse.json(
        { ok: false, error: { message: '대화를 업데이트할 수 없습니다.' } },
        { status: 500 }
      );
    }

    return NextResponse.json({ ok: true, data: conversation });
  } catch (error) {
    console.error('대화 업데이트 중 오류:', error);
    return NextResponse.json(
      { ok: false, error: { message: '오류가 발생했습니다.', details: error } },
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
    const { data: existing } = await supabaseAdmin
      .from('conversations')
      .select('id')
      .eq('id', conversationId)
      .eq('user_id', session.user.id)
      .maybeSingle();

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
      { ok: false, error: { message: '오류가 발생했습니다.', details: error } },
      { status: 500 }
    );
  }
}