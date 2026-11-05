import { NextRequest, NextResponse } from 'next/server';
import { getServerAuthSession } from '@/lib/auth';
import { getActorScope } from '@/lib/actor-scope';
import { reuseFile } from '@/lib/attachments/reuse';

export const dynamic = 'force-dynamic';
// 직접 올리기의 확인과 같은 읽기를 한다(큰 엑셀·스캔 PDF는 NODA /parse) — 같은 300초
export const maxDuration = 300;

function jsonError(message: string, status: number) {
  return NextResponse.json({ ok: false, error: { message } }, { status });
}

/**
 * 지난 파일을 새 첨부로 다시 붙인다 — `{ kind: 'attachment' | 'generated', id }`. 원본은 요청자의 것만.
 * 직접 올리기 확인과 같이 읽지 못한 파일도 200 + status 'failed'
 */
export async function POST(request: NextRequest) {
  const session = await getServerAuthSession();
  if (!session?.user?.id) return jsonError('인증이 필요합니다.', 401);
  // 소속을 모르면 거절한다 — 추측해서 배정하지 않는다
  const actor = await getActorScope(session);
  if (!actor?.organizationId) return jsonError('소속 기관을 확인할 수 없습니다.', 403);

  let body: { kind?: unknown; id?: unknown };
  try {
    body = await request.json();
  } catch {
    return jsonError('요청 형식이 올바르지 않습니다.', 400);
  }
  const result = await reuseFile({ userId: actor.userId, departmentId: actor.departmentId, organizationId: actor.organizationId }, body.kind, body.id);
  if (!result.ok) return jsonError(result.message, result.status);
  return NextResponse.json({ ok: true, data: result.attachment });
}
