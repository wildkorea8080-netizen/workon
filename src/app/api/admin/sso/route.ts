import { NextRequest, NextResponse } from 'next/server';
import { getServerAuthSession, isAdminSession } from '@/lib/auth';
import { actorScopeOr503 } from '@/lib/actor-scope-response';
import { readJsonObject, BAD_BODY_MESSAGE } from '@/lib/request-body';
import { logSecurityEvent } from '@/lib/security-log';
import { EncryptionKeyMissingError } from '@/lib/crypto';
import { supabaseAdmin } from '@/lib/supabaseAdmin';
import { appBaseUrl, configView, defaultSsoAdminIo, defaultSsoIo, parseSsoConfig, saveSsoConfig, SSO_CALLBACK_PATH } from '@/lib/org-sso';

export const dynamic = 'force-dynamic';

function jsonError(message: string, status: number) {
  return NextResponse.json({ ok: false, error: { message } }, { status });
}

async function orgSlug(organizationId: string): Promise<string | null> {
  const { data, error } = await supabaseAdmin.from('organizations').select('slug').eq('id', organizationId).maybeSingle();
  if (error) throw new Error('organizations');
  return (data as { slug: string | null } | null)?.slug ?? null;
}

/** 기관 SSO 설정 보기(0107) — 관리자 누구나. 비밀값은 '있음'만, 계정 서비스에 등록할 돌아올 주소·로그인 주소를 함께 */
export async function GET() {
  const session = await getServerAuthSession();
  if (!session?.user?.id || !isAdminSession(session)) return jsonError('관리자 권한이 필요합니다.', 403);
  const scope = await actorScopeOr503(session);
  if (scope instanceof Response) return scope;
  if (!scope?.organizationId) return jsonError('소속 기관을 확인할 수 없습니다.', 403);
  try {
    const [row, slug] = await Promise.all([defaultSsoIo().loadConfig(scope.organizationId), orgSlug(scope.organizationId)]);
    return NextResponse.json({
      ok: true,
      data: {
        config: configView(row),
        redirectUri: `${appBaseUrl()}${SSO_CALLBACK_PATH}`,
        loginPath: slug ? `/signin/${slug}` : null,
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
    if (parsed.value.enabled && !(await orgSlug(scope.organizationId))) {
      return jsonError('기관 로그인 경로(slug)가 없어 켤 수 없습니다. 기관 정보에서 로그인 경로를 먼저 정해 주세요.', 400);
    }
    const saved = await saveSsoConfig(scope.organizationId, scope.userId, parsed.value, defaultSsoAdminIo());
    if (!saved.ok) return jsonError(saved.message, saved.status);
    if (saved.changed.length) {
      await logSecurityEvent(scope.departmentId, scope.userId, 'org_sso_changed', { changed: saved.changed, enabled: saved.view.enabled, sso_only: saved.view.ssoOnly, issuer: saved.view.issuer }, 'high');
    }
    return NextResponse.json({ ok: true, data: { config: saved.view } });
  } catch (error) {
    if (error instanceof EncryptionKeyMissingError) return jsonError('서버의 암호화 키가 없어 비밀값을 저장하지 못했습니다. 서비스 운영자에게 문의하세요.', 503);
    return jsonError('SSO 설정을 저장하지 못했습니다. 잠시 뒤 다시 시도해 주세요.', 503);
  }
}
