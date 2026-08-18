import { NextResponse } from 'next/server';
import { getServerAuthSession } from '@/lib/auth';
import { connectorCatalog } from '@/lib/connectors';

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

  return NextResponse.json({ ok: true, data: connectorCatalog() });
}
