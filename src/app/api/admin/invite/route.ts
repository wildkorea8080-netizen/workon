import { NextRequest, NextResponse } from 'next/server';
import { getServerAuthSession, isAdminSession } from '@/lib/auth';
import { supabaseAdmin } from '@/lib/supabaseAdmin';
import { sendInvitationEmail } from '@/lib/mailer';
import { APP_URL } from '@/lib/config';
import { getManagedDepartmentIds } from '@/lib/department-scope';
import { logSecurityEvent } from '@/lib/security-log';
import { checkUserSeats, SEAT_LIMIT_CODE } from '@/lib/user-seats';

export const dynamic = 'force-dynamic';

/**
 * 기관 관리자의 직원 초대 — 만들기(POST)·목록(GET). 취소는 `[id]`.
 *
 * 2026-11-18에 고친 것:
 * - **초대를 보안 로그에 남긴다**(`user_invited` — 관리자 초대는 high). 예전에는 누군가를 관리자로 초대해도 어디에도 남지 않았고,
 *   초대 행은 취소로 지울 수 있어 흔적이 없었다(슈퍼관리자의 초대 링크는 남았다)
 * - 대리 접근 중에는 관리자 초대를 만들지 못한다(기록이 그 기관 관리자 이름으로 남으므로)
 * - 이미 가입한 이메일·이미 있는 초대 확인이 읽기 실패를 '없음'으로 보지 않는다(500) — 예전 `.single()`은 실패와 없음을 가르지 못했다
 * - 이메일 꼴·권한 값을 본다(아무 글이나 초대 행이 됐다)
 * - 기관의 사용자 수 상한에 이미 닿았으면 초대를 만들지 않는다(초대해도 가입에서 막힌다 — 확인을 못 하면 만든다, 가입 때 다시 본다)
 * - 목록은 관리 범위(자기 부서 + 하위, 기관 직속 부서 관리자는 기관 전체)
 */

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const fail = (message: string, status: number, code?: string) =>
  NextResponse.json({ ok: false, error: code ? { message, code } : { message } }, { status });

export async function POST(request: NextRequest) {
  try {
    const session = await getServerAuthSession();
    if (!session?.user?.id || !isAdminSession(session)) return fail('관리자 권한이 필요합니다.', 403);

    const departmentId = session.user.departmentId;
    if (!departmentId) return fail('부서 정보를 찾을 수 없습니다.', 403);

    let body: { email?: unknown; role?: unknown };
    try {
      body = await request.json();
    } catch {
      return fail('요청 형식이 올바르지 않습니다.', 400);
    }

    if (!body.email || typeof body.email !== 'string') return fail('이메일은 필수입니다.', 400);
    const normalizedEmail = body.email.trim().toLowerCase();
    if (normalizedEmail.length > 254 || !EMAIL.test(normalizedEmail)) return fail('이메일 주소가 올바르지 않습니다.', 400);

    const role = body.role === undefined || body.role === null ? 'USER' : String(body.role).toUpperCase();
    if (role !== 'ADMIN' && role !== 'USER') return fail('권한은 ADMIN 또는 USER만 가능합니다.', 400);

    // 대리 접근 중의 조작은 그 기관 관리자 이름으로 기록된다 — 관리자 초대는 슈퍼관리자 화면의 초대 링크로(그쪽은 슈퍼관리자 이름으로 남는다)
    if (role === 'ADMIN' && session.user.isImpersonating) {
      return fail('대리 접근 중에는 관리자를 초대할 수 없습니다. 슈퍼관리자 기관 화면의 초대 링크를 쓰세요.', 403);
    }

    // 이미 가입된 이메일 확인 — 못 읽으면 '없음'으로 보지 않는다
    const { data: existingUsers, error: userError } = await supabaseAdmin
      .from('users')
      .select('id')
      .eq('email', normalizedEmail)
      .limit(1);
    if (userError) return fail('가입 여부를 확인하지 못했습니다. 잠시 뒤 다시 시도해 주세요.', 500);
    if ((existingUsers ?? []).length > 0) return fail('이미 가입된 이메일입니다.', 400);

    // 유효한 초대가 이미 있는지 확인
    const { data: existingInvites, error: inviteError } = await supabaseAdmin
      .from('invitations')
      .select('id')
      .eq('email', normalizedEmail)
      .eq('department_id', departmentId)
      .is('accepted_at', null)
      .gt('expires_at', new Date().toISOString())
      .limit(1);
    if (inviteError) return fail('초대 여부를 확인하지 못했습니다. 잠시 뒤 다시 시도해 주세요.', 500);
    if ((existingInvites ?? []).length > 0) return fail('이미 유효한 초대가 존재합니다.', 400);

    // 상한에 이미 닿았으면 초대해도 가입에서 막힌다. 확인을 못 했으면 만든다(가입 때 다시 본다)
    const seats = await checkUserSeats(departmentId, 1);
    if (!seats.ok && seats.code === SEAT_LIMIT_CODE) return fail(seats.message, 403, seats.code);

    // 토큰 생성
    const token = `${crypto.randomUUID()}-${Date.now()}`;

    const { data: invitation, error } = await supabaseAdmin
      .from('invitations')
      .insert({
        email: normalizedEmail,
        department_id: departmentId,
        role,
        token,
        invited_by: session.user.id,
      })
      .select('id, email, role, expires_at, created_at')
      .single();

    if (error || !invitation) {
      console.error('[invite] 초대 생성 오류:', error);
      return fail('초대 생성에 실패했습니다.', 500);
    }

    // 보안 로그 실패는 초대를 되돌리지 않는다(실패는 운영 기록에 남는다). 초대 열쇠는 싣지 않는다
    await logSecurityEvent(
      departmentId,
      session.user.id,
      'user_invited',
      {
        invitation_id: invitation.id,
        invited_email: normalizedEmail,
        invited_role: role,
        ...(session.user.isImpersonating ? { impersonating: true } : {}),
      },
      role === 'ADMIN' ? 'high' : 'low'
    );

    const inviteUrl = `${APP_URL}/register?token=${token}`;

    // 기관명은 메일 본문에만 쓰이므로 조회 실패해도 발송을 막지 않는다
    const { data: department } = await supabaseAdmin
      .from('departments')
      .select('organizations(name)')
      .eq('id', departmentId)
      .maybeSingle();
    const orgRelation = (department as any)?.organizations;
    const organizationName = Array.isArray(orgRelation) ? orgRelation[0]?.name : orgRelation?.name;

    const mail = await sendInvitationEmail({
      to: normalizedEmail,
      inviteUrl,
      organizationName,
      expiresAt: invitation.expires_at,
    });

    return NextResponse.json({
      ok: true,
      data: {
        inviteUrl,
        invitation,
        // 발송 실패/미설정 시 관리자가 링크를 직접 전달할 수 있도록 상태를 함께 내려준다
        emailSent: mail.sent,
        emailError: mail.sent ? undefined : mail.reason,
      },
    });
  } catch (error) {
    console.error('[invite] 오류:', error);
    return fail('서버 오류가 발생했습니다.', 500);
  }
}

export async function GET(_request: NextRequest) {
  try {
    const session = await getServerAuthSession();
    if (!session?.user?.id || !isAdminSession(session)) return fail('관리자 권한이 필요합니다.', 403);

    const departmentId = session.user.departmentId;
    if (!departmentId) return fail('부서 정보를 찾을 수 없습니다.', 403);

    // 하위 부서 관리자가 만든 초대도 상위 관리자가 본다 — 못 읽으면 자기 부서만(좁히는 쪽)
    const managed = await getManagedDepartmentIds(departmentId);

    const { data: invitations, error } = await supabaseAdmin
      .from('invitations')
      .select('id, email, role, expires_at, accepted_at, created_at')
      .in('department_id', managed)
      .order('created_at', { ascending: false });

    if (error) return fail('초대 목록 조회에 실패했습니다.', 500);

    return NextResponse.json({ ok: true, data: invitations });
  } catch (error) {
    console.error('[invite GET] 오류:', error);
    return fail('서버 오류가 발생했습니다.', 500);
  }
}
