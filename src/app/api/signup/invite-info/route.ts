import { NextRequest, NextResponse } from 'next/server';
import { supabaseAdmin } from '@/lib/supabaseAdmin';
import { SIGNUP_READ_FAILED_MESSAGE, departmentOrgRejection, departmentOrgState } from '@/lib/signup-org';

export const dynamic = 'force-dynamic';

// 공개 API — 초대 토큰으로 기관/역할 정보 미리보기
export async function GET(request: NextRequest) {
  const token = new URL(request.url).searchParams.get('token') ?? '';
  // 실패는 실패 상태 코드로(2026-11-22) — 예전엔 모두 200이라 상태를 보는 곳이 성공으로 셌다
  if (!token) return NextResponse.json({ ok: false, error: '초대 링크가 올바르지 않습니다' }, { status: 400 });

  try {
    const { data: inv, error: invError } = await supabaseAdmin
      .from('invitations')
      .select('email, role, department_id, expires_at, accepted_at')
      .eq('token', token)
      .maybeSingle();

    // 못 읽으면 '유효하지 않은 초대 링크'가 아니라 그렇다고(2026-11-19)
    if (invError) return NextResponse.json({ ok: false, error: SIGNUP_READ_FAILED_MESSAGE }, { status: 503 });
    if (!inv) return NextResponse.json({ ok: false, error: '유효하지 않은 초대 링크' }, { status: 404 });
    if (inv.accepted_at) return NextResponse.json({ ok: false, error: '이미 사용된 초대 링크' }, { status: 410 });
    if (new Date(inv.expires_at) < new Date()) return NextResponse.json({ ok: false, error: '만료된 초대 링크' }, { status: 410 });

    // 부서 → 기관명·상태 — 정지·종료한 기관·없어진 부서면 가입 화면을 열기 전에 알린다(2026-11-19)
    let orgName: string | null = null;
    if (inv.department_id) {
      const state = await departmentOrgState(inv.department_id);
      const rejected = departmentOrgRejection(state);
      if (rejected) return NextResponse.json({ ok: false, error: rejected.message }, { status: rejected.status });
      orgName = state.kind === 'ok' ? state.orgName : null;
    }

    return NextResponse.json({
      ok: true,
      data: { orgName, role: inv.role, email: inv.email },
    });
  } catch {
    // 처리 중 예외는 '지금 확인하지 못함' — 예전엔 아무 글 없는 200
    return NextResponse.json({ ok: false, error: SIGNUP_READ_FAILED_MESSAGE }, { status: 503 });
  }
}
