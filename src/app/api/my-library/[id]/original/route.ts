import { NextRequest, NextResponse } from 'next/server';
import { getServerAuthSession } from '@/lib/auth';
import { actorScopeOr503 } from '@/lib/actor-scope-response';
import { findLibraryOriginal } from '@/lib/my-library';
import { signedDownloadUrl } from '@/lib/generated-files';

export const dynamic = 'force-dynamic';

function jsonError(message: string, status: number) {
  return NextResponse.json({ ok: false, error: { message } }, { status });
}

/** 자료함 파일 내려받기 — 내 자료함은 주인만(관리자도 못 받는다), 부서 자료함은 지금 그 부서 사람만. 60초 서명 주소로 302 */
export async function GET(_request: NextRequest, { params }: { params: { id: string } }) {
  const session = await getServerAuthSession();
  if (!session?.user?.id) return jsonError('인증이 필요합니다.', 401);
  const actor = await actorScopeOr503(session);
  if (actor instanceof Response) return actor;
  if (!actor?.organizationId) return jsonError('소속 기관을 확인할 수 없습니다.', 403);
  let file: Awaited<ReturnType<typeof findLibraryOriginal>>;
  try {
    file = await findLibraryOriginal({ userId: actor.userId, organizationId: actor.organizationId, departmentId: actor.departmentId, isAdmin: actor.isAdmin }, params.id);
  } catch {
    return jsonError('파일을 지금 불러올 수 없습니다. 잠시 뒤 다시 시도해 주세요.', 503);
  }
  if (!file) return jsonError('파일을 찾을 수 없습니다.', 404);
  const url = await signedDownloadUrl(file.storage_path, file.file_name);
  if (!url) return jsonError('내려받을 주소를 만들지 못했습니다. 잠시 뒤 다시 시도해 주세요.', 500);
  return NextResponse.redirect(url, 302);
}
