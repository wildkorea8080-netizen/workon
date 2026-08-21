import { NextRequest, NextResponse } from 'next/server';
import { getServerAuthSession } from '@/lib/auth';
import { supabaseAdmin } from '@/lib/supabaseAdmin';
import { randomBytes } from 'crypto';
import { APP_URL } from '@/lib/config';

function nanoid12() {
  return randomBytes(9).toString('base64url').slice(0, 12);
}

/** 공유 주소를 한 곳에서 만든다. 두 핸들러가 다른 주소를 주면 안 된다. */
function shareUrl(token: string) {
  return `${APP_URL}/shared/${token}`;
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

    return NextResponse.json({ ok: true, data: { shareUrl: shareUrl(token), token } });
  } catch (error) {
    console.error('[conversation share]', error);
    return NextResponse.json(
      { ok: false, error: { message: '서버 오류가 발생했습니다.' } },
      { status: 500 }
    );
  }
}

/**
 * 공유 상태 조회.
 *
 * 화면이 "공유 중"인지 알아야 링크 복사와 중단 중 무엇을 보일지 정한다.
 * 목록을 받아올 때 함께 실어도 되지만, 대화 하나를 열었을 때만 필요한
 * 값이라 목록 응답을 무겁게 하지 않는다.
 */
export async function GET(
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

    const { data, error } = await supabaseAdmin
      .from('conversations')
      .select('share_token, is_shared')
      .eq('id', params.id)
      .eq('user_id', session.user.id)
      .maybeSingle();

    if (error || !data) {
      return NextResponse.json(
        { ok: false, error: { message: '대화를 찾을 수 없습니다.' } },
        { status: 404 }
      );
    }

    return NextResponse.json({
      ok: true,
      data: {
        isShared: Boolean(data.is_shared),
        shareUrl: data.is_shared && data.share_token ? shareUrl(data.share_token) : null,
      },
    });
  } catch (error) {
    console.error('[conversation share GET]', error);
    return NextResponse.json(
      { ok: false, error: { message: '서버 오류가 발생했습니다.' } },
      { status: 500 }
    );
  }
}

/**
 * 공유 중단.
 *
 * **한 번 공유하면 영구히 열려 있었다.** 링크를 만든 사람이 그 사실을
 * 잊어도 링크는 계속 살아 있고, 토큰만 알면 로그인 없이 대화 전문이
 * 보인다. 공공기관 대화에는 민원인 정보·검토 중인 방침이 섞이므로
 * 되돌릴 수단이 반드시 있어야 한다.
 *
 * **토큰도 함께 지운다.** `is_shared`만 내리면 조회 경로는 막히지만
 * (`/api/shared/[token]`이 두 값을 함께 본다) 토큰이 남아 있어 다시
 * 공유할 때 같은 주소가 되살아난다. 예전에 링크를 받아 둔 사람이
 * 그대로 다시 볼 수 있게 되므로, 중단은 주소를 버리는 것이어야 한다.
 */
export async function DELETE(
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

    // 소유자만 중단할 수 있다. 남의 대화를 닫아 버리면 안 된다.
    const { data: existing, error: fetchError } = await supabaseAdmin
      .from('conversations')
      .select('id')
      .eq('id', params.id)
      .eq('user_id', session.user.id)
      .maybeSingle();

    if (fetchError || !existing) {
      return NextResponse.json(
        { ok: false, error: { message: '대화를 찾을 수 없습니다.' } },
        { status: 404 }
      );
    }

    const { error } = await supabaseAdmin
      .from('conversations')
      .update({ is_shared: false, share_token: null })
      .eq('id', params.id);

    if (error) {
      console.error('[conversation share DELETE]', error);
      return NextResponse.json(
        { ok: false, error: { message: '공유 중단 중 오류가 발생했습니다.' } },
        { status: 500 }
      );
    }

    return NextResponse.json({ ok: true, data: { isShared: false } });
  } catch (error) {
    console.error('[conversation share DELETE]', error);
    return NextResponse.json(
      { ok: false, error: { message: '서버 오류가 발생했습니다.' } },
      { status: 500 }
    );
  }
}
