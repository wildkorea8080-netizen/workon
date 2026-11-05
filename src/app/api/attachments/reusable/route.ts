import { NextResponse } from 'next/server';
import { getServerAuthSession } from '@/lib/auth';
import { listReusableFiles } from '@/lib/attachments/reuse';

export const dynamic = 'force-dynamic';

function jsonError(message: string, status: number) {
  return NextResponse.json({ ok: false, error: { message } }, { status });
}

/** 대화에 다시 붙일 수 있는 내 지난 파일(최근 90일 — 보낸 첨부·비서가 만들어 준 파일). 저장소 경로는 싣지 않는다 */
export async function GET() {
  const session = await getServerAuthSession();
  if (!session?.user?.id) return jsonError('인증이 필요합니다.', 401);
  try {
    return NextResponse.json({ ok: true, data: await listReusableFiles(session.user.id) });
  } catch {
    return jsonError('지난 파일을 불러오지 못했습니다. 잠시 뒤 다시 시도해 주세요.', 503);
  }
}
