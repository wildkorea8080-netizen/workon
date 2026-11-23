import { NextRequest, NextResponse } from 'next/server';
import { BAD_BODY_MESSAGE, readJsonObject } from '@/lib/request-body';
import bcrypt from 'bcryptjs';
import { supabaseAdmin } from '@/lib/supabaseAdmin';
import { claimInvitation, isInvitationClaimError, releaseInvitation, INVITATION_CLAIM_UNAVAILABLE } from '@/lib/invitation-claim';
import { checkUserSeats, seatErrorBody } from '@/lib/user-seats';
import { SIGNUP_READ_FAILED_MESSAGE, departmentOrgRejection, departmentOrgState } from '@/lib/signup-org';

export async function POST(request: NextRequest) {
  try {
    const body = await readJsonObject(request);
    if (!body) return NextResponse.json({ ok: false, error: { message: BAD_BODY_MESSAGE } }, { status: 400 });
    const { token, name, password } = body;

    if (!token || !password) {
      return NextResponse.json(
        { ok: false, error: { message: '토큰과 비밀번호는 필수입니다.' } },
        { status: 400 }
      );
    }

    if (password.length < 8) {
      return NextResponse.json(
        { ok: false, error: { message: '비밀번호는 8자 이상이어야 합니다.' } },
        { status: 400 }
      );
    }

    // 토큰 재검증
    const { data: invitation, error: inviteError } = await supabaseAdmin
      .from('invitations')
      .select('id, email, department_id, role, expires_at, accepted_at')
      .eq('token', token)
      .maybeSingle();

    // 못 읽으면 '유효하지 않은 초대 링크'가 아니라 그렇다고(2026-11-19)
    if (inviteError) {
      return NextResponse.json({ ok: false, error: { message: SIGNUP_READ_FAILED_MESSAGE } }, { status: 503 });
    }
    if (!invitation) {
      return NextResponse.json(
        { ok: false, error: { message: '유효하지 않은 초대 링크입니다.' } },
        { status: 400 }
      );
    }

    if (invitation.accepted_at) {
      return NextResponse.json(
        { ok: false, error: { message: '이미 사용된 초대 링크입니다.' } },
        { status: 400 }
      );
    }

    if (new Date(invitation.expires_at) < new Date()) {
      return NextResponse.json(
        { ok: false, error: { message: '만료된 초대 링크입니다.' } },
        { status: 400 }
      );
    }

    // 이메일 중복 최종 확인
    const { data: existingUser, error: existingError } = await supabaseAdmin
      .from('users')
      .select('id')
      .eq('email', invitation.email)
      .maybeSingle();
    // 못 읽으면 '없음'으로 보지 않는다(2026-11-19)
    if (existingError) {
      return NextResponse.json({ ok: false, error: { message: SIGNUP_READ_FAILED_MESSAGE } }, { status: 503 });
    }

    if (existingUser) {
      return NextResponse.json(
        { ok: false, error: { message: '이미 가입된 이메일입니다.' } },
        { status: 400 }
      );
    }

    if (!invitation.department_id) {
      return NextResponse.json(
        { ok: false, error: { message: '초대의 소속 부서를 확인할 수 없습니다. 새 초대 링크를 요청하세요.' } },
        { status: 400 }
      );
    }

    // 정지·종료한 기관·없어진 부서에는 가입하지 않는다(2026-11-19)
    const rejected = departmentOrgRejection(await departmentOrgState(invitation.department_id));
    if (rejected) return NextResponse.json({ ok: false, error: { message: rejected.message } }, { status: rejected.status });

    // 기관의 사용자 수 상한(2026-11-17) — 초대를 쓰기 전에 센다(상한이면 초대는 그대로 남는다)
    const seats = await checkUserSeats(invitation.department_id, 1);
    if (!seats.ok) return NextResponse.json(seatErrorBody(seats), { status: seats.status });

    // 계정을 만들기 전에 초대를 차지한다(2026-11-12) — 같은 링크로 거의 동시에 둘이 가입하지 못하게
    let claimedAt: string | null;
    try {
      claimedAt = await claimInvitation(invitation.id);
    } catch (claimError) {
      // DB가 실패한 것은 '이미 사용됨'이 아니다(2026-11-20)
      if (isInvitationClaimError(claimError)) {
        return NextResponse.json({ ok: false, error: { message: INVITATION_CLAIM_UNAVAILABLE } }, { status: 503 });
      }
      throw claimError;
    }
    if (!claimedAt) {
      return NextResponse.json(
        { ok: false, error: { message: '이미 사용됐거나 만료된 초대 링크입니다.' } },
        { status: 400 }
      );
    }

    // 비밀번호 해싱
    const passwordHash = await bcrypt.hash(password, 12);

    // 사용자 생성
    const { data: newUser, error: userError } = await supabaseAdmin
      .from('users')
      .insert({
        email: invitation.email,
        full_name: name?.trim() || null,
        role: invitation.role,
        department_id: invitation.department_id,
        password_hash: passwordHash,
      })
      .select('id, email, role')
      .single();

    if (userError) {
      await releaseInvitation(invitation.id, claimedAt);
      console.error('[register] 사용자 생성 오류:', userError);
      return NextResponse.json(
        { ok: false, error: { message: '회원가입에 실패했습니다.' } },
        { status: 500 }
      );
    }

    // 초대는 위에서 차지할 때 이미 쓴 것으로 표시했다

    return NextResponse.json({
      ok: true,
      data: { id: newUser.id, email: newUser.email, role: newUser.role },
    });
  } catch (error) {
    console.error('[register] 오류:', error);
    return NextResponse.json(
      { ok: false, error: { message: '서버 오류가 발생했습니다.' } },
      { status: 500 }
    );
  }
}
