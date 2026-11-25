import { NextRequest, NextResponse } from 'next/server';
import { getServerAuthSession, isAdminSession } from '@/lib/auth';
import { actorScopeOr503 } from '@/lib/actor-scope-response';
import { readJsonObject, BAD_BODY_MESSAGE } from '@/lib/request-body';
import { logSecurityEvent } from '@/lib/security-log';
import { EncryptionKeyMissingError } from '@/lib/crypto';
import { supabaseAdmin } from '@/lib/supabaseAdmin';
import { pagedRows } from '@/lib/paged-select';
import { appBaseUrl, configView, defaultSsoAdminIo, defaultSsoIo, parseSsoConfig, saveSsoConfig, SSO_BACKCHANNEL_PATH, SSO_CALLBACK_PATH } from '@/lib/org-sso';

export const dynamic = 'force-dynamic';

function jsonError(message: string, status: number) {
  return NextResponse.json({ ok: false, error: { message } }, { status });
}

async function orgSlug(organizationId: string): Promise<string | null> {
  const { data, error } = await supabaseAdmin.from('organizations').select('slug').eq('id', organizationId).maybeSingle();
  if (error) throw new Error('organizations');
  return (data as { slug: string | null } | null)?.slug ?? null;
}

/** 이 기관의 부서(그룹 → 부서 맞추기 고르기, 0110) — 못 읽으면 던진다 */
async function orgDepartments(organizationId: string): Promise<{ id: string; name: string }[]> {
  const read = await pagedRows<{ id: string; name: string }>((a, b, w) =>
    supabaseAdmin.from('departments').select('id, name', w ? { count: 'exact' } : undefined).eq('organization_id', organizationId).order('name').order('id').range(a, b));
  if (read.error || read.truncated) throw new Error('departments');
  return read.data;
}

/** 기관 SSO 설정 보기(0107) — 관리자 누구나. 비밀값은 '있음'만, 계정 서비스에 등록할 돌아올 주소·로그인 주소를 함께 */
export async function GET() {
  const session = await getServerAuthSession();
  if (!session?.user?.id || !isAdminSession(session)) return jsonError('관리자 권한이 필요합니다.', 403);
  const scope = await actorScopeOr503(session);
  if (scope instanceof Response) return scope;
  if (!scope?.organizationId) return jsonError('소속 기관을 확인할 수 없습니다.', 403);
  try {
    const [row, slug, departments] = await Promise.all([defaultSsoIo().loadConfig(scope.organizationId), orgSlug(scope.organizationId), orgDepartments(scope.organizationId)]);
    return NextResponse.json({
      ok: true,
      data: {
        config: configView(row),
        redirectUri: `${appBaseUrl()}${SSO_CALLBACK_PATH}`,
        backchannelUri: `${appBaseUrl()}${SSO_BACKCHANNEL_PATH}`,
        loginPath: slug ? `/signin/${slug}` : null,
        departments,
        canManage: scope.managesWholeOrganization && !session.user.isImpersonating,
      },
    });
  } catch {
    return jsonError('SSO 설정을 지금 읽지 못했습니다. 잠시 뒤 다시 시도해 주세요.', 503);
  }
}

/**
 * 기관 SSO 설정 저장 — 기관 전체 관리자만, 대리 접근 중 403. 켤 때는 발견 문서를 실제로 읽어 보고 못 읽으면 저장하지 않는다.
 * 비밀값은 비우면 그대로. 보안 로그 high(바뀐 칸 이름만 — 값·비밀값 없음)
 */
export async function PUT(request: NextRequest) {
  const session = await getServerAuthSession();
  if (!session?.user?.id || !isAdminSession(session)) return jsonError('관리자 권한이 필요합니다.', 403);
  if (session.user.isImpersonating) return jsonError('대리 접근 중에는 바꿀 수 없습니다.', 403);
  const scope = await actorScopeOr503(session);
  if (scope instanceof Response) return scope;
  if (!scope?.managesWholeOrganization || !scope.organizationId) return jsonError('기관 전체 관리자(최상위 부서 소속)만 바꿀 수 있습니다.', 403);
  const body = await readJsonObject(request);
  if (!body) return jsonError(BAD_BODY_MESSAGE, 400);
  const parsed = parseSsoConfig(body);
  if (!parsed.ok) return jsonError(parsed.message, 400);
  try {
    // (0110) 그룹 → 부서의 부서는 이 기관 부서만
    const mappedIds = [...new Set(parsed.value.groupMappings.map((m) => m.departmentId))];
    if (mappedIds.length) {
      const { data: found, error: deptError } = await supabaseAdmin.from('departments').select('id').in('id', mappedIds).eq('organization_id', scope.organizationId);
      if (deptError) return jsonError('부서를 지금 확인하지 못했습니다. 잠시 뒤 다시 시도해 주세요.', 503);
      if (((found ?? []) as { id: string }[]).length !== mappedIds.length) return jsonError('그룹 → 부서 목록에 이 기관의 부서가 아닌 것이 있습니다. 목록을 다시 골라 주세요.', 400);
    }
    if (parsed.value.enabled && !(await orgSlug(scope.organizationId))) {
      return jsonError('기관 로그인 경로(slug)가 없어 켤 수 없습니다. 기관 정보에서 로그인 경로를 먼저 정해 주세요.', 400);
    }
    const saved = await saveSsoConfig(scope.organizationId, scope.userId, parsed.value, defaultSsoAdminIo());
    if (!saved.ok) return jsonError(saved.message, saved.status);
    if (saved.changed.length) {
      await logSecurityEvent(scope.departmentId, scope.userId, 'org_sso_changed', { changed: saved.changed, enabled: saved.view.enabled, sso_only: saved.view.ssoOnly, single_logout: saved.view.singleLogout, issuer: saved.view.issuer, group_claim: saved.view.groupClaim, group_mappings: saved.view.groupMappings.length }, 'high');
    }
    return NextResponse.json({ ok: true, data: { config: saved.view } });
  } catch (error) {
    if (error instanceof EncryptionKeyMissingError) return jsonError('서버의 암호화 키가 없어 비밀값을 저장하지 못했습니다. 서비스 운영자에게 문의하세요.', 503);
    return jsonError('SSO 설정을 저장하지 못했습니다. 잠시 뒤 다시 시도해 주세요.', 503);
  }
}
