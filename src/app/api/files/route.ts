import { NextRequest, NextResponse } from 'next/server';
import { getServerAuthSession } from '@/lib/auth';
import { listMyGeneratedFiles, normalizeFileQuery, parseCursor } from '@/lib/my-generated-files';

export const dynamic = 'force-dynamic';

function jsonError(message: string, status: number) {
  return NextResponse.json({ ok: false, error: { message } }, { status });
}

/**
 * 내가 대화에서 만든 파일 목록(2026-11-07) — 결과물 화면이 부른다. 주인 것만, 최근 것부터 50개씩(`?cursor=` 앞 쪽 마지막 파일의 시각·id, 꼴이 다르면 400).
 * `?q=`면 이름에 그 글이 든 파일만(2026-11-08).
 * 내려받기는 그대로 `/api/files/[id]`(주인만, 60초 서명 주소)
 */
export async function GET(request: NextRequest) {
  const session = await getServerAuthSession();
  if (!session?.user?.id) return jsonError('인증이 필요합니다.', 401);
  const params = new URL(request.url).searchParams;
  const cursorText = params.get('cursor');
  // 파일 이름 찾기(2026-11-08) — 다듬어 60자까지, 비면 전체
  const query = normalizeFileQuery(params.get('q'));
  const cursor = cursorText ? parseCursor(cursorText) : null;
  if (cursorText && !cursor) return jsonError('목록 조회 조건을 확인해 주세요.', 400);
  try {
    return NextResponse.json({ ok: true, data: await listMyGeneratedFiles(session.user.id, cursor, query) });
  } catch {
    return jsonError('파일 목록을 지금 불러올 수 없습니다. 잠시 뒤 다시 시도해 주세요.', 503);
  }
}
