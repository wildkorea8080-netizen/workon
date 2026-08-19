import { NextRequest, NextResponse } from 'next/server';
import { getServerAuthSession, isAdminSession } from '@/lib/auth';
import { supabaseAdmin } from '@/lib/supabaseAdmin';
import { sendInvitationEmail } from '@/lib/mailer';
import { APP_URL } from '@/lib/config';

export async function POST(request: NextRequest) {
  try {
    const session = await getServerAuthSession();
    if (!session?.user?.id || !isAdminSession(session)) {
      return NextResponse.json(
        { ok: false, error: { message: '관리자 권한이 필요합니다.' } },
        { status: 403 }
      );
    }

    const departmentId = session.user.departmentId;
    if (!departmentId) {
      return NextResponse.json(
        { ok: false, error: { message: '부서 정보를 찾을 수 없습니다.' } },
        { status: 403 }
      );
    }

    const body = await request.json();
    const { email, role = 'USER' } = body;

    if (!email || typeof email !== 'string') {
      return NextResponse.json(
        { ok: false, error: { message: '이메일은 필수입니다.' } },
        { status: 400 }
      );
    }

    const normalizedEmail = email.trim().toLowerCase();

    // 이미 가입된 이메일 확인
    const { data: existingUser } = await supabaseAdmin
      .from('users')
      .select('id')
      .eq('email', normalizedEmail)
      .single();

    if (existingUser) {
      return NextResponse.json(
        { ok: false, error: { message: '이미 가입된 이메일입니다.' } },
        { status: 400 }
      );
    }

    // 유효한 초대가 이미 있는지 확인
    const { data: existingInvite } = await supabaseAdmin
      .from('invitations')
      .select('id, expires_at')
      .eq('email', normalizedEmail)
      .eq('department_id', departmentId)
      .is('accepted_at', null)
      .gt('expires_at', new Date().toISOString())
      .single();

    if (existingInvite) {
      return NextResponse.json(
        { ok: false, error: { message: '이미 유효한 초대가 존재합니다.' } },
        { status: 400 }
      );
    }

    // 토큰 생성
    const token = `${crypto.randomUUID()}-${Date.now()}`;

    const { data: invitation, error } = await supabaseAdmin
      .from('invitations')
      .insert({
        email: normalizedEmail,
        department_id: departmentId,
        role: role === 'ADMIN' ? 'ADMIN' : 'USER',
        token,
        invited_by: session.user.id,
      })
      .select()
      .single();

    if (error) {
      console.error('[invite] 초대 생성 오류:', error);
      return NextResponse.json(
        { ok: false, error: { message: '초대 생성에 실패했습니다.' } },
        { status: 500 }
      );
    }

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
    return NextResponse.json(
      { ok: false, error: { message: '서버 오류가 발생했습니다.' } },
      { status: 500 }
    );
  }
}

export async function GET(_request: NextRequest) {
  try {
    const session = await getServerAuthSession();
    if (!session?.user?.id || !isAdminSession(session)) {
      return NextResponse.json(
        { ok: false, error: { message: '관리자 권한이 필요합니다.' } },
        { status: 403 }
      );
    }

    const departmentId = session.user.departmentId;
    if (!departmentId) {
      return NextResponse.json(
        { ok: false, error: { message: '부서 정보를 찾을 수 없습니다.' } },
        { status: 403 }
      );
    }

    const { data: invitations, error } = await supabaseAdmin
      .from('invitations')
      .select('id, email, role, expires_at, accepted_at, created_at')
      .eq('department_id', departmentId)
      .order('created_at', { ascending: false });

    if (error) {
      return NextResponse.json(
        { ok: false, error: { message: '초대 목록 조회에 실패했습니다.' } },
        { status: 500 }
      );
    }

    return NextResponse.json({ ok: true, data: invitations });
  } catch (error) {
    console.error('[invite GET] 오류:', error);
    return NextResponse.json(
      { ok: false, error: { message: '서버 오류가 발생했습니다.' } },
      { status: 500 }
    );
  }
}
