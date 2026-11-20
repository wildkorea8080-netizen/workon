import { NextRequest, NextResponse } from 'next/server';
import { supabaseAdmin } from '@/lib/supabaseAdmin';
import { SIGNUP_READ_FAILED_MESSAGE, departmentOrgRejection, departmentOrgState } from '@/lib/signup-org';

export const dynamic = 'force-dynamic';

// 공개 API — 초대 토큰으로 기관/역할 정보 미리보기
export async function GET(request: NextRequest) {
  const token = new URL(request.url).searchParams.get('token') ?? '';
  if (!token) return NextResponse.json({ ok: false });

  try {
    const { data: inv, error: invError } = await supabaseAdmin
      .from('invitations')
      .select('email, role, department_id, expires_at, accepted_at')
      .eq('token', token)
      .maybeSingle();

    // 못 읽으면 '유효하지 않은 초대 링크'가 아니라 그렇다고(2026-11-19)
    if (invError) return NextResponse.json({ ok: false, error: SIGNUP_READ_FAILED_MESSAGE }, { status: 503 });
    if (!inv) return NextResponse.json({ ok: false, error: '유효하지 않은 초대 링크' });
    if (inv.accepted_at) return NextResponse.json({ ok: false, error: '이미 사용된 초대 링크' });
    if (new Date(inv.expires_at) < new Date()) return NextResponse.json({ ok: false, error: '만료된 초대 링크' });

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
    return NextResponse.json({ ok: false });
  }
}
