import { NextRequest, NextResponse } from 'next/server';
import { getServerAuthSession, isAdminSession } from '@/lib/auth';
import { actorScopeOr503 } from '@/lib/actor-scope-response';
import { readJsonObject, BAD_BODY_MESSAGE } from '@/lib/request-body';
import { logSecurityEvent } from '@/lib/security-log';
import { supabaseAdmin } from '@/lib/supabaseAdmin';
import { pagedRows } from '@/lib/paged-select';
import { createShare, listShares } from '@/lib/library-shares';

export const dynamic = 'force-dynamic';

function jsonError(message: string, status: number) {
  return NextResponse.json({ ok: false, error: { message } }, { status });
}

/** 이 기관의 부서(고르기용) — 못 읽으면 던진다 */
async function orgDepartments(organizationId: string): Promise<{ id: string; name: string }[]> {
  const read = await pagedRows<{ id: string; name: string }>((a, b, w) =>
    supabaseAdmin.from('departments').select('id, name', w ? { count: 'exact' } : undefined).eq('organization_id', organizationId).order('name').order('id').range(a, b));
  if (read.error || read.truncated) throw new Error('departments');
  return read.data;
}

/** 공유 자료함 목록(0116) — 관리자 누구나 본다(부서 목록·파일 수와 함께). 바꾸기는 기관 전체 관리자만(`canManage`) */
export async function GET() {
  const session = await getServerAuthSession();
  if (!session?.user?.id || !isAdminSession(session)) return jsonError('관리자 권한이 필요합니다.', 403);
  const scope = await actorScopeOr503(session);
  if (scope instanceof Response) return scope;
  if (!scope?.organizationId) return jsonError('소속 기관을 확인할 수 없습니다.', 403);
  const listed = await listShares(scope.organizationId);
  if (!listed.ok) return jsonError(listed.message, listed.status);
  let departments: { id: string; name: string }[];
  try {
    departments = await orgDepartments(scope.organizationId);
  } catch {
    return jsonError('부서 목록을 지금 읽지 못했습니다. 잠시 뒤 다시 시도해 주세요.', 503);
  }
  return NextResponse.json({ ok: true, data: { shares: listed.shares, departments, canManage: scope.managesWholeOrganization && !session.user.isImpersonating } });
}

/** 공유 자료함 만들기 — `{ name, departmentIds }`. 기관 전체 관리자만, 대리 접근 중 403. 보안 로그 medium */
export async function POST(request: NextRequest) {
  const session = await getServerAuthSession();
  if (!session?.user?.id || !isAdminSession(session)) return jsonError('관리자 권한이 필요합니다.', 403);
  if (session.user.isImpersonating) return jsonError('대리 접근 중에는 공유 자료함을 바꿀 수 없습니다.', 403);
  const scope = await actorScopeOr503(session);
  if (scope instanceof Response) return scope;
  if (!scope?.organizationId) return jsonError('소속 기관을 확인할 수 없습니다.', 403);
  if (!scope.managesWholeOrganization) return jsonError('공유 자료함은 기관 전체 관리자(최상위 부서 소속)만 만들고 고칩니다.', 403);
  const body = await readJsonObject(request);
  if (!body) return jsonError(BAD_BODY_MESSAGE, 400);
  const result = await createShare(scope.organizationId, scope.userId, body);
  if (!result.ok) return jsonError(result.message, result.status);
  await logSecurityEvent(scope.departmentId, scope.userId, 'library_share_changed', { action: 'created', share_id: result.share.id, name: result.share.name, departments: result.share.departmentIds.length }, 'medium');
  return NextResponse.json({ ok: true, data: result.share }, { status: 201 });
}
