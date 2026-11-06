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
    // 숫자가 아니거나 너무 크면 범위 조회가 깨지거나 1,000행 상한에 걸린다 — 1~100, 0 이상으로 맞춘다
    const rawLimit = parseInt(searchParams.get('limit') || '20', 10);
    const rawOffset = parseInt(searchParams.get('offset') || '0', 10);
    const limit = Number.isFinite(rawLimit) ? Math.min(100, Math.max(1, rawLimit)) : 20;
    const offset = Number.isFinite(rawOffset) ? Math.max(0, rawOffset) : 0;

    // 사용자의 대화 목록 조회
    const { data: conversations, error } = await supabaseAdmin
      .from('conversations')
      .select('id, title, created_at, updated_at, is_shared, agent:agents(id, name)')
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
    const conversationIds: string[] = (conversations || []).map((c: { id: string }) => c.id);
    let firstMessages: Record<string, string> = {};

    if (conversationIds.length > 0) {
      // 대화마다 첫 사용자 메시지 한 줄만(2026-11-06). 예전에는 모든 대화의 사용자 메시지를 한 번에 읽어,
      // 1,000행 상한(오류 없이 앞부분만 옴)을 넘으면 뒤 대화의 미리보기가 조용히 빠졌다. 미리보기는 200자
      const firsts = await Promise.all(conversationIds.map((id) => supabaseAdmin
        .from('messages')
        .select('content')
        .eq('conversation_id', id)
        .eq('role', 'user')
        .order('created_at', { ascending: true })
        .limit(1)
        .maybeSingle()));
      conversationIds.forEach((id, i) => {
        const content = (firsts[i].data as { content?: unknown } | null)?.content;
        if (typeof content === 'string') firstMessages[id] = content.slice(0, 200);
      });
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