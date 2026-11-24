import { NextRequest, NextResponse } from 'next/server';
import { getServerAuthSession } from '@/lib/auth';
import { supabaseAdmin } from '@/lib/supabaseAdmin';
import { randomBytes } from 'crypto';
import { APP_URL } from '@/lib/config';
import { logSecurityEvent } from '@/lib/security-log';
import { shareCreateBlockedMessage, shareSwitchForDepartment } from '@/lib/share-switch';

function nanoid12() {
  return randomBytes(9).toString('base64url').slice(0, 12);
}

/** 공유 주소를 한 곳에서 만든다. 두 핸들러가 다른 주소를 주면 안 된다. */
function shareUrl(token: string) {
  return `${APP_URL}/shared/${token}`;
}

const fail = (message: string, status: number) =>
  NextResponse.json({ ok: false, error: { message } }, { status });

/**
 * 공유 시작(또는 다시 복사).
 *
 * 2026-11-18:
 * - **공유는 그때까지의 대화다**(`metadata.shared_at`). 예전에는 링크가 대화의 '지금'을 보여 줘, 공유한 뒤 이어 쓴 대화가
 *   링크를 받은 사람에게 그대로 보였다(로그인 없이). 이제 공개 조회는 공유한 때까지의 메시지만 준다 —
 *   이후 대화를 보이려면 '공유 링크 복사'를 다시 누른다(주소는 그대로, 범위만 지금까지로).
 * - 공유한 것을 보안 로그에 남긴다(`conversation_shared` — 대화 id만, 제목·내용 없음). 로그인 없이 열리는 링크를 누가 언제 만들었는지
 *   어디에도 남지 않았다.
 */
export async function POST(
  _request: NextRequest,
  { params }: { params: { id: string } }
) {
  try {
    const session = await getServerAuthSession();
    if (!session?.user?.id) return fail('인증이 필요합니다.', 401);

    const { data: existing, error: fetchError } = await supabaseAdmin
      .from('conversations')
      .select('id, share_token, is_shared, department_id, metadata')
      .eq('id', params.id)
      .eq('user_id', session.user.id)
      .maybeSingle();

    if (fetchError) return fail('대화를 확인하지 못했습니다. 잠시 뒤 다시 시도해 주세요.', 500);
    if (!existing) return fail('대화를 찾을 수 없습니다.', 404);

    // 기관이 공개 링크를 막았으면 만들지도 범위를 늘리지도 않는다(0098) — 못 읽으면 만들지 않는다(닫힘)
    let blocked;
    try {
      blocked = await shareSwitchForDepartment(existing.department_id as string | null);
    } catch {
      return fail('공개 링크를 지금 만들 수 있는지 확인하지 못했습니다. 잠시 뒤 다시 시도해 주세요.', 503);
    }
    if (blocked.disabled) {
      return NextResponse.json({ ok: false, error: { message: shareCreateBlockedMessage(blocked.reason), code: 'share_disabled' } }, { status: 403 });
    }

    const wasShared = Boolean(existing.is_shared && existing.share_token);
    // 공유 중이면 같은 주소를 쓴다(중단하면 주소를 버리므로 여기 남은 토큰은 살아 있는 링크다)
    const token = wasShared ? (existing.share_token as string) : nanoid12();
    const sharedAt = new Date().toISOString();
    const metadata =
      existing.metadata && typeof existing.metadata === 'object' && !Array.isArray(existing.metadata)
        ? (existing.metadata as Record<string, unknown>)
        : {};

    const { data: updated, error } = await supabaseAdmin
      .from('conversations')
      .update({ share_token: token, is_shared: true, metadata: { ...metadata, shared_at: sharedAt } })
      .eq('id', params.id)
      .eq('user_id', session.user.id)
      .select('id');

    if (error) return fail('공유 링크 생성 중 오류가 발생했습니다.', 500);
    if (((updated ?? []) as unknown[]).length === 0) return fail('대화를 찾을 수 없습니다.', 404);

    // 기록 실패는 공유를 되돌리지 않는다(실패는 운영 기록에 남는다)
    await logSecurityEvent(
      existing.department_id ?? session.user.departmentId ?? null,
      session.user.id,
      'conversation_shared',
      { conversation_id: existing.id, ...(wasShared ? { share_updated: true } : {}) },
      wasShared ? 'low' : 'medium'
    );

    return NextResponse.json({ ok: true, data: { shareUrl: shareUrl(token), token, sharedAt, updated: wasShared } });
  } catch (error) {
    console.error('[conversation share]', error);
    return fail('서버 오류가 발생했습니다.', 500);
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
    if (!session?.user?.id) return fail('인증이 필요합니다.', 401);

    const { data, error } = await supabaseAdmin
      .from('conversations')
      .select('share_token, is_shared, metadata')
      .eq('id', params.id)
      .eq('user_id', session.user.id)
      .maybeSingle();

    // 못 읽은 것은 '없음'이 아니다(2026-11-20) — 공유 시작(POST)과 같은 갈래
    if (error) return fail('대화를 확인하지 못했습니다. 잠시 뒤 다시 시도해 주세요.', 503);
    if (!data) return fail('대화를 찾을 수 없습니다.', 404);

    const sharedAt = (data.metadata as { shared_at?: unknown } | null)?.shared_at;
    return NextResponse.json({
      ok: true,
      data: {
        isShared: Boolean(data.is_shared),
        shareUrl: data.is_shared && data.share_token ? shareUrl(data.share_token) : null,
        // 링크에 보이는 범위 — 이때까지의 대화(없으면 이 기능 전에 공유한 것: 대화 전체)
        sharedAt: data.is_shared && typeof sharedAt === 'string' ? sharedAt : null,
      },
    });
  } catch (error) {
    console.error('[conversation share GET]', error);
    return fail('서버 오류가 발생했습니다.', 500);
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
    if (!session?.user?.id) return fail('인증이 필요합니다.', 401);

    // 소유자만 중단할 수 있다. 남의 대화를 닫아 버리면 안 된다.
    const { data: existing, error: fetchError } = await supabaseAdmin
      .from('conversations')
      .select('id, is_shared, department_id, metadata')
      .eq('id', params.id)
      .eq('user_id', session.user.id)
      .maybeSingle();

    if (fetchError) return fail('대화를 확인하지 못했습니다. 잠시 뒤 다시 시도해 주세요.', 500);
    if (!existing) return fail('대화를 찾을 수 없습니다.', 404);

    const metadata =
      existing.metadata && typeof existing.metadata === 'object' && !Array.isArray(existing.metadata)
        ? { ...(existing.metadata as Record<string, unknown>) }
        : {};
    delete metadata.shared_at;

    const { error } = await supabaseAdmin
      .from('conversations')
      .update({ is_shared: false, share_token: null, metadata })
      .eq('id', params.id)
      .eq('user_id', session.user.id);

    if (error) {
      console.error('[conversation share DELETE]', error);
      return fail('공유 중단 중 오류가 발생했습니다.', 500);
    }

    // 공유 중이던 것을 멈췄을 때만 남긴다(이미 멈춘 대화에 다시 눌러도 기록은 없다)
    if (existing.is_shared) {
      await logSecurityEvent(
        existing.department_id ?? session.user.departmentId ?? null,
        session.user.id,
        'conversation_unshared',
        { conversation_id: existing.id },
        'low'
      );
    }

    return NextResponse.json({ ok: true, data: { isShared: false } });
  } catch (error) {
    console.error('[conversation share DELETE]', error);
    return fail('서버 오류가 발생했습니다.', 500);
  }
}
