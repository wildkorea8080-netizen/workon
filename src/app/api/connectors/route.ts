import { NextResponse } from 'next/server';
import { getServerAuthSession } from '@/lib/auth';
import { connectorCatalog } from '@/lib/connectors';
import { supabaseAdmin } from '@/lib/supabaseAdmin';
import { readPersonalConnectorIds } from '@/lib/connector-scope';

export const dynamic = 'force-dynamic';

/**
 * 현재 사용 가능한 외부 도구 커넥터 목록.
 * 에이전트 설정 화면에서 켜고 끌 대상을 보여주는 데 씁니다.
 */
export async function GET() {
  const session = await getServerAuthSession();
  if (!session?.user?.id) {
    return NextResponse.json(
      { ok: false, error: { message: '인증이 필요합니다.' } },
      { status: 401 }
    );
  }

  const catalog = connectorCatalog();

  // 직원이 '나만의 비서'에 켤 수 있는 범위를 함께 알려준다.
  // 관리자 화면은 이 값을 무시하고 전체를 쓴다.
  // 소속·공식 비서를 못 읽으면 503(2026-11-20) — 예전엔 '켤 수 있는 연결 없음'으로 답해 이미 켠 연결이 '범위 밖'으로 보였다
  const unread = () => NextResponse.json(
    { ok: false, error: { message: '연결 목록을 지금 불러오지 못했습니다. 잠시 뒤 다시 시도해 주세요.' } },
    { status: 503 }
  );
  let departmentId = session.user.departmentId;
  if (!departmentId) {
    const { data, error } = await supabaseAdmin
      .from('users')
      .select('department_id')
      .eq('id', session.user.id)
      .maybeSingle();
    if (error) return unread();
    departmentId = data?.department_id ?? undefined;
  }

  const personalIds = departmentId ? await readPersonalConnectorIds(departmentId) : [];
  if (!personalIds) return unread();
  const allowed = new Set(personalIds);

  return NextResponse.json({
    ok: true,
    data: catalog.map((c) => ({ ...c, allowedForPersonal: allowed.has(c.id) })),
  });
}
