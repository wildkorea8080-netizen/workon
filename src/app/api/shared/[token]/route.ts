import { NextRequest, NextResponse } from 'next/server';
import { supabaseAdmin } from '@/lib/supabaseAdmin';
import { sharedMessages, type SharedMessageRow } from '@/lib/shared-conversation';
import { SHARE_OPEN_BLOCKED_MESSAGE, shareSwitchForDepartment } from '@/lib/share-switch';

const NOT_FOUND = () =>
  NextResponse.json({ ok: false, error: { message: '공유된 대화를 찾을 수 없습니다.' } }, { status: 404 });
/** 못 읽은 것(2026-11-20) — 열지는 않되(닫힘) '없음'이라고 하지 않는다. 링크를 받은 사람이 공유가 취소된 줄 알았다 */
const UNREAD = () =>
  NextResponse.json({ ok: false, error: { message: '공유된 대화를 지금 열지 못했습니다. 잠시 뒤 다시 열어 주세요.' } }, { status: 503 });

/**
 * 공개 공유 링크(로그인 없음) — 토큰이 곧 자격.
 *
 * 2026-11-18:
 * - **공유한 때까지의 대화만** 준다(`metadata.shared_at`). 예전에는 대화의 '지금'을 줘 공유 뒤 이어 쓴 대화까지 보였다
 * - 대화 주인의 계정이 사용 중지·탈퇴 상태면 열지 않는다 — 퇴직·전출로 계정을 끈 직원이 만들어 둔 링크가 계속 살아 있었다.
 *   주인을 확인하지 못해도 열지 않는다(닫힘 — 로그인 없이 열리는 주소다)
 * - 응답은 정해 둔 칸만(주인 id·메타는 싣지 않는다)
 */
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
        user_id,
        department_id,
        metadata,
        agent:agents(id, name, description),
        messages(
          id,
          role,
          content,
          created_at,
          revised:source_references->revision->>text,
          revised_status:source_references->revision->>status,
          revised_at:source_references->revision->>created_at
        )
      `)
      .eq('share_token', params.token)
      .eq('is_shared', true)
      // 시간순, 같은 시각(한 턴의 질문·답)이면 질문이 먼저(2026-11-18 — 예전엔 순서를 정하지 않았다)
      .order('created_at', { referencedTable: 'messages', ascending: true })
      .order('role', { referencedTable: 'messages', ascending: false })
      .maybeSingle();

    if (error) return UNREAD();
    if (!conversation) return NOT_FOUND();

    const row = conversation as unknown as {
      id: string;
      title: string | null;
      created_at: string;
      user_id: string | null;
      department_id: string | null;
      metadata: { shared_at?: unknown } | null;
      agent: unknown;
      messages: SharedMessageRow[] | null;
    };

    // 주인의 계정 — 사용 중지·탈퇴면 링크도 닫는다
    if (!row.user_id) return NOT_FOUND();
    const { data: owner, error: ownerError } = await supabaseAdmin
      .from('users')
      .select('is_active, deleted_at')
      .eq('id', row.user_id)
      .maybeSingle();
    // 주인을 확인하지 못하면 열지 않는다(닫힘) — 다만 '없음'이 아니라 '지금 못 엶'
    if (ownerError) return UNREAD();
    if (!owner) return NOT_FOUND();
    if ((owner as { is_active?: boolean | null }).is_active === false || (owner as { deleted_at?: string | null }).deleted_at) {
      return NOT_FOUND();
    }

    // 기관이 공개 링크를 막았으면 열지 않는다(0098, 2026-11-23) — 링크는 지우지 않아 다시 열면 그대로. 못 읽으면 열지 않는다(닫힘)
    let blocked;
    try {
      blocked = await shareSwitchForDepartment(row.department_id);
    } catch {
      return UNREAD();
    }
    if (blocked.disabled) {
      return NextResponse.json({ ok: false, error: { message: SHARE_OPEN_BLOCKED_MESSAGE, code: 'share_disabled' } }, { status: 403 });
    }

    return NextResponse.json({
      ok: true,
      data: {
        id: row.id,
        title: row.title,
        created_at: row.created_at,
        agent: row.agent ?? null,
        // 근거로 고쳐 쓴 답(2026-11-26)은 공유한 때까지 고쳐 쓴 것만 글로 — 근거 발췌는 읽지도 않는다
        messages: sharedMessages(row.messages ?? [], row.metadata?.shared_at),
      },
    });
  } catch (error) {
    console.error('[shared conversation GET]', error);
    return NextResponse.json(
      { ok: false, error: { message: '서버 오류가 발생했습니다.' } },
      { status: 500 }
    );
  }
}
