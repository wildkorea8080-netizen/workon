import { NextRequest, NextResponse } from 'next/server';
import { getServerAuthSession, isAdminSession } from '@/lib/auth';
import { actorScopeOr503 } from '@/lib/actor-scope-response';
import { readJsonObject, BAD_BODY_MESSAGE } from '@/lib/request-body';
import { logSecurityEvent } from '@/lib/security-log';
import { deleteShare, updateShare } from '@/lib/library-shares';

export const dynamic = 'force-dynamic';

function jsonError(message: string, status: number) {
  return NextResponse.json({ ok: false, error: { message } }, { status });
}

/** 기관 전체 관리자만(대리 접근 중 403) — 요청자 범위, 아니면 응답 */
async function requireAdminWholeOrg() {
  const session = await getServerAuthSession();
  if (!session?.user?.id || !isAdminSession(session)) return jsonError('관리자 권한이 필요합니다.', 403);
  if (session.user.isImpersonating) return jsonError('대리 접근 중에는 공유 자료함을 바꿀 수 없습니다.', 403);
  const scope = await actorScopeOr503(session);
  if (scope instanceof Response) return scope;
  if (!scope?.organizationId) return jsonError('소속 기관을 확인할 수 없습니다.', 403);
  if (!scope.managesWholeOrganization) return jsonError('공유 자료함은 기관 전체 관리자(최상위 부서 소속)만 만들고 고칩니다.', 403);
  return { organizationId: scope.organizationId, departmentId: scope.departmentId, userId: scope.userId };
}

/** 공유 자료함 고치기(0116) — `{ name?, departmentIds? }`. 부서를 빼면 그 부서 사람은 더 못 본다(파일은 남는다). 보안 로그 medium */
export async function PATCH(request: NextRequest, { params }: { params: { id: string } }) {
  const scope = await requireAdminWholeOrg();
  if (scope instanceof Response) return scope;
  const body = await readJsonObject(request);
  if (!body) return jsonError(BAD_BODY_MESSAGE, 400);
  const result = await updateShare(scope.organizationId, params.id, body);
  if (!result.ok) return jsonError(result.message, result.status);
  if (result.changed.length) {
    await logSecurityEvent(scope.departmentId, scope.userId, 'library_share_changed', { action: 'updated', share_id: params.id, changed: result.changed }, 'medium');
  }
  return NextResponse.json({ ok: true, data: { id: params.id, changed: result.changed } });
}

/** 공유 자료함 지우기 — 파일이 남아 있으면 409 */
export async function DELETE(_request: NextRequest, { params }: { params: { id: string } }) {
  const scope = await requireAdminWholeOrg();
  if (scope instanceof Response) return scope;
  const result = await deleteShare(scope.organizationId, params.id);
  if (!result.ok) return jsonError(result.message, result.status);
  await logSecurityEvent(scope.departmentId, scope.userId, 'library_share_changed', { action: 'deleted', share_id: params.id, name: result.name }, 'medium');
  return NextResponse.json({ ok: true, data: { id: params.id } });
}
