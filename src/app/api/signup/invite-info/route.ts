import { NextRequest, NextResponse } from 'next/server';
import { supabaseAdmin } from '@/lib/supabaseAdmin';

export const dynamic = 'force-dynamic';

// 공개 API — 초대 토큰으로 기관/역할 정보 미리보기
export async function GET(request: NextRequest) {
  const token = new URL(request.url).searchParams.get('token') ?? '';
  if (!token) return NextResponse.json({ ok: false });

  try {
    const { data: inv } = await supabaseAdmin
      .from('invitations')
      .select('email, role, department_id, expires_at, accepted_at')
      .eq('token', token)
      .maybeSingle();

    if (!inv) return NextResponse.json({ ok: false, error: '유효하지 않은 초대 링크' });
    if (inv.accepted_at) return NextResponse.json({ ok: false, error: '이미 사용된 초대 링크' });
    if (new Date(inv.expires_at) < new Date()) return NextResponse.json({ ok: false, error: '만료된 초대 링크' });

    // 부서 → 기관명 조회
    let orgName: string | null = null;
    if (inv.department_id) {
      const { data: dept } = await supabaseAdmin
        .from('departments')
        .select('organization_id, organizations(name)')
        .eq('id', inv.department_id)
        .maybeSingle();
      orgName = (dept as any)?.organizations?.name ?? null;
    }

    return NextResponse.json({
      ok: true,
      data: { orgName, role: inv.role, email: inv.email },
    });
  } catch {
    return NextResponse.json({ ok: false });
  }
}
