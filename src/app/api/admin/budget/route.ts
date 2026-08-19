import { NextResponse } from 'next/server';
import { getServerAuthSession, isAdminSession } from '@/lib/auth';
import { supabaseAdmin } from '@/lib/supabaseAdmin';
import { checkTokenLimit } from '@/lib/usage-limit';

export const dynamic = 'force-dynamic';

/**
 * 기관 관리자용 예산·한도 현황.
 *
 * 0017에서 연간 정액 계약(annual_fixed)과 organization_spend_krw를 넣었지만
 * **보는 화면이 슈퍼관리자에만 있었다.** 정작 예산을 집행하는 기관 담당자가
 * 자기 소진율을 못 봤다. 공공기관은 분기별 집행률 보고가 있어서 이건 조회
 * 편의가 아니라 업무 요건이다.
 *
 * 판정 로직은 checkTokenLimit이 이미 갖고 있다. 여기서 다시 계산하면 화면과
 * 실제 차단 기준이 어긋날 수 있으므로 같은 함수를 쓴다.
 */
export async function GET() {
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

  const status = await checkTokenLimit(departmentId);

  const { data: dept } = await supabaseAdmin
    .from('departments')
    .select('organization_id')
    .eq('id', departmentId)
    .maybeSingle();

  let billingType: string | null = null;
  let contractEndsAt: string | null = null;

  if (dept?.organization_id) {
    const { data: contract } = await supabaseAdmin
      .from('contracts')
      .select('billing_type, expires_at')
      .eq('organization_id', dept.organization_id)
      .eq('status', 'active')
      .order('started_at', { ascending: false })
      .limit(1)
      .maybeSingle();

    billingType = contract?.billing_type ?? null;
    contractEndsAt = contract?.expires_at ?? null;
  }

  // 계약 만료까지 남은 일수. 공공기관은 계약 종료 전에 차기 예산을 잡아야 해서
  // 소진율만큼이나 남은 기간이 중요하다.
  let daysLeft: number | null = null;
  if (contractEndsAt) {
    const diff = new Date(contractEndsAt).getTime() - Date.now();
    daysLeft = Math.max(0, Math.ceil(diff / 86400000));
  }

  return NextResponse.json({
    ok: true,
    data: {
      billingType,
      organizationName: status.organizationName ?? null,
      allowed: status.allowed,
      reason: status.reason ?? null,
      usedTokens: status.usedTokens,
      limitTokens: status.limitTokens,
      budget: status.budget ?? null,
      contractEndsAt,
      daysLeft,
    },
  });
}
