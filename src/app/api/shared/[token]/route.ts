import { NextRequest, NextResponse } from 'next/server';
import { supabaseAdmin } from '@/lib/supabaseAdmin';

export async function GET(
  _request: NextRequest,
  { params }: { params: { token: string } }
) {
  try {
    const { data: conversation, error } = await supabaseAdmin
      .from('conversations')
      .select(`
        id,
        title,
        created_at,
        is_shared,
        agent:agents(id, name, description),
        messages(
          id,
          role,
          content,
          created_at
        )
      `)
      .eq('share_token', params.token)
      .eq('is_shared', true)
      .single();

    if (error || !conversation) {
      return NextResponse.json(
        { ok: false, error: { message: '공유된 대화를 찾을 수 없습니다.' } },
        { status: 404 }
      );
    }

    return NextResponse.json({ ok: true, data: conversation });
  } catch (error) {
    console.error('[shared conversation GET]', error);
    return NextResponse.json(
      { ok: false, error: { message: '서버 오류가 발생했습니다.' } },
      { status: 500 }
    );
  }
}
