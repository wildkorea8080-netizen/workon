import { NextRequest, NextResponse } from 'next/server';
import { getServerAuthSession } from '@/lib/auth';
import { supabaseAdmin } from '@/lib/supabaseAdmin';

export async function GET(request: NextRequest) {
  try {
    const session = await getServerAuthSession();
    if (!session?.user?.id) {
      return NextResponse.json(
        { ok: false, error: { message: '인증이 필요합니다.' } },
        { status: 401 }
      );
    }

    const { searchParams } = new URL(request.url);
    const limit = parseInt(searchParams.get('limit') || '20');
    const offset = parseInt(searchParams.get('offset') || '0');

    // 사용자의 대화 목록 조회
    const { data: conversations, error } = await supabaseAdmin
      .from('conversations')
      .select('id, title, created_at, updated_at, agent:agents(name)')
      .eq('user_id', session.user.id)
      .order('updated_at', { ascending: false })
      .range(offset, offset + limit - 1);

    if (error) {
      console.error('대화 목록 조회 오류:', error);
      return NextResponse.json(
        { ok: false, error: { message: '대화 목록을 불러올 수 없습니다.' } },
        { status: 500 }
      );
    }

    // 각 대화의 첫 번째 사용자 메시지를 미리보기로 추가
    const conversationIds = (conversations || []).map((c: { id: string }) => c.id);
    let firstMessages: Record<string, string> = {};

    if (conversationIds.length > 0) {
      const { data: msgs } = await supabaseAdmin
        .from('messages')
        .select('conversation_id, content, role')
        .in('conversation_id', conversationIds)
        .eq('role', 'user')
        .order('created_at', { ascending: true });

      if (msgs) {
        // conversation_id별로 첫 번째 메시지만 보관
        for (const msg of msgs) {
          if (!firstMessages[msg.conversation_id]) {
            firstMessages[msg.conversation_id] = msg.content;
          }
        }
      }
    }

    const enriched = (conversations || []).map((c: any) => ({
      ...c,
      first_message: firstMessages[c.id] ?? null,
    }));

    return NextResponse.json({ ok: true, data: enriched });
  } catch (error) {
    console.error('대화 목록 조회 중 오류:', error);
    return NextResponse.json(
      { ok: false, error: { message: '오류가 발생했습니다.', details: error } },
      { status: 500 }
    );
  }
}

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
    const { agent_id, title } = body;

    if (!agent_id) {
      return NextResponse.json(
        { ok: false, error: { message: '에이전트 ID가 필요합니다.' } },
        { status: 400 }
      );
    }

    // 새 대화 생성
    const { data: conversation, error } = await supabaseAdmin
      .from('conversations')
      .insert({
        user_id: session.user.id,
        agent_id,
        title: title || '새 대화',
      })
      .select()
      .single();

    if (error) {
      console.error('대화 생성 오류:', error);
      return NextResponse.json(
        { ok: false, error: { message: '대화를 생성할 수 없습니다.' } },
        { status: 500 }
      );
    }

    return NextResponse.json({ ok: true, data: conversation });
  } catch (error) {
    console.error('대화 생성 중 오류:', error);
    return NextResponse.json(
      { ok: false, error: { message: '오류가 발생했습니다.', details: error } },
      { status: 500 }
    );
  }
}