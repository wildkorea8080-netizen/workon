import { NextRequest, NextResponse } from 'next/server';
import { getServerAuthSession } from '@/lib/auth';
import { supabaseAdmin } from '@/lib/supabaseAdmin';
import { randomBytes } from 'crypto';

function nanoid12() {
  return randomBytes(9).toString('base64url').slice(0, 12);
}

export async function POST(
  _request: NextRequest,
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

    const { data: existing, error: fetchError } = await supabaseAdmin
      .from('conversations')
      .select('id, share_token, is_shared')
      .eq('id', params.id)
      .eq('user_id', session.user.id)
      .maybeSingle();

    if (fetchError || !existing) {
      return NextResponse.json(
        { ok: false, error: { message: '대화를 찾을 수 없습니다.' } },
        { status: 404 }
      );
    }

    // 이미 공유 토큰이 있으면 재사용
    const token = existing.share_token ?? nanoid12();

    const { error } = await supabaseAdmin
      .from('conversations')
      .update({ share_token: token, is_shared: true })
      .eq('id', params.id);

    if (error) {
      return NextResponse.json(
        { ok: false, error: { message: '공유 링크 생성 중 오류가 발생했습니다.' } },
        { status: 500 }
      );
    }

    const baseUrl = process.env.NEXTAUTH_URL || process.env.NEXT_PUBLIC_APP_URL || 'http://localhost:3000';
    const shareUrl = `${baseUrl}/shared/${token}`;

    return NextResponse.json({ ok: true, data: { shareUrl, token } });
  } catch (error) {
    console.error('[conversation share]', error);
    return NextResponse.json(
      { ok: false, error: { message: '서버 오류가 발생했습니다.' } },
      { status: 500 }
    );
  }
}
