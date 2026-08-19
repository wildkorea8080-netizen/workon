import { NextResponse } from 'next/server';
import { getServerAuthSession } from '@/lib/auth';
import { supabaseAdmin } from '@/lib/supabaseAdmin';
import { getAllowedModelIds, describeModels } from '@/lib/model-policy';

export const dynamic = 'force-dynamic';

/**
 * 이 직원이 대화에 쓸 수 있는 모델 목록.
 *
 * 기관 관리자가 정한 허용 목록(0021)을 그대로 따른다. 화면은 여기서 받은
 * 것만 보여주면 되고, 실제 제한은 /api/chat이 다시 건다 — 화면 필터는
 * 표시일 뿐이라는 원칙은 커넥터 범위와 같다.
 */
export async function GET() {
  const session = await getServerAuthSession();
  if (!session?.user?.id) {
    return NextResponse.json(
      { ok: false, error: { message: '인증이 필요합니다.' } },
      { status: 401 }
    );
  }

  let departmentId = session.user.departmentId;
  if (!departmentId) {
    const { data } = await supabaseAdmin
      .from('users')
      .select('department_id')
      .eq('id', session.user.id)
      .maybeSingle();
    departmentId = data?.department_id ?? undefined;
  }

  let organizationId: string | null = null;
  if (departmentId) {
    const { data } = await supabaseAdmin
      .from('departments')
      .select('organization_id')
      .eq('id', departmentId)
      .maybeSingle();
    organizationId = data?.organization_id ?? null;
  }

  const allowed = await getAllowedModelIds(organizationId);

  return NextResponse.json({
    ok: true,
    data: describeModels(allowed).map((m) => ({
      id: m.id,
      label: m.label,
      note: m.note,
      inputPerMTok: m.inputPerMTok,
      outputPerMTok: m.outputPerMTok,
    })),
  });
}
