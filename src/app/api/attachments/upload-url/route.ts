import { NextRequest, NextResponse } from 'next/server';
import { getServerAuthSession } from '@/lib/auth';
import { getActorScope } from '@/lib/actor-scope';
import { createUpload } from '@/lib/attachments/store';

export const dynamic = 'force-dynamic';

function jsonError(message: string, status: number) {
  return NextResponse.json({ ok: false, error: { message } }, { status });
}

/**
 * ① 채팅 첨부 업로드 주소. 파일은 브라우저가 저장소에 직접 올린다 —
 * Vercel 함수의 요청 본문 상한(4.5MB) 때문이다(설계 4.1). 경로는 서버가 정한다.
 */
export async function POST(request: NextRequest) {
  const session = await getServerAuthSession();
  if (!session?.user?.id) return jsonError('인증이 필요합니다.', 401);

  // 소속을 모르면 거절한다 — 추측해서 배정하지 않는다(CLAUDE.md 구조적 위험 0)
  const actor = await getActorScope(session);
  if (!actor?.organizationId) return jsonError('소속 기관을 확인할 수 없습니다.', 403);

  let body: { file_name?: unknown; size?: unknown };
  try {
    body = await request.json();
  } catch {
    return jsonError('요청 형식이 올바르지 않습니다.', 400);
  }

  const result = await createUpload(
    { userId: actor.userId, departmentId: actor.departmentId, organizationId: actor.organizationId },
    { fileName: typeof body.file_name === 'string' ? body.file_name : '', size: Number(body.size) }
  );
  if (!result.ok) return jsonError(result.message, result.status);

  return NextResponse.json({ ok: true, data: { id: result.id, path: result.path, token: result.token } });
}
