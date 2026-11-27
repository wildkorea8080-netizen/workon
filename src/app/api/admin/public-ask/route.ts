import { NextResponse, type NextRequest } from 'next/server';
import { getServerAuthSession, isAdminSession } from '@/lib/auth';
import { actorScopeOr503 } from '@/lib/actor-scope-response';
import { supabaseAdmin } from '@/lib/supabaseAdmin';
import { readJsonObject, BAD_BODY_MESSAGE } from '@/lib/request-body';
import { logSecurityEvent } from '@/lib/security-log';
import { APP_URL } from '@/lib/config';
import { embedSnippet, parsePublicAskSettings, readContacts, PUBLIC_ASK_IP_CAP, PUBLIC_ASK_ORG_CAP } from '@/lib/public-ask/spec';

export const dynamic = 'force-dynamic';

function jsonError(message: string, status: number) {
  return NextResponse.json({ ok: false, error: { message } }, { status });
}
const UNREAD = '시민 상담 설정을 지금 읽지 못했습니다. 잠시 뒤 다시 시도해 주세요.';
const WHOLE_ONLY = '시민 상담 창은 기관 전체 관리자(최상위 부서 소속)만 다룹니다.';

/**
 * 시민용 민원 상담 창 설정(2026-11-27, 0136) — 기관 전체 관리자만(시민에게 무엇을 보일지 정하는 일).
 * GET = 설정·시민 전용 비서·상담 주소·붙일 코드, PUT = 설정 저장(켤 때 사유·시민 전용 비서·기관 주소(slug) 필요, 대리 접근 403, 보안 로그 high)
 */
export async function GET() {
  const session = await getServerAuthSession();
  if (!session?.user?.id || !isAdminSession(session)) return jsonError('관리자 권한이 필요합니다.', 403);
  const actor = await actorScopeOr503(session);
  if (actor instanceof Response) return actor;
  if (!actor?.organizationId) return jsonError('소속 기관을 확인할 수 없습니다.', 403);
  if (!actor.managesWholeOrganization) return jsonError(WHOLE_ONLY, 403);

  const [org, settings, agent] = await Promise.all([
    supabaseAdmin.from('organizations').select('slug').eq('id', actor.organizationId).maybeSingle(),
    supabaseAdmin.from('public_ask_settings').select('enabled, enabled_at, enabled_reason, agent_id, notice, faq, contacts, allowed_origins, ip_daily_cap, org_daily_cap, updated_at').eq('organization_id', actor.organizationId).maybeSingle(),
    supabaseAdmin.from('agents').select('id, name').eq('organization_id', actor.organizationId).eq('tier', 'public').is('deleted_at', null).maybeSingle(),
  ]);
  if (org.error || settings.error || agent.error) return jsonError(UNREAD, 503);
  let documents: number | null = null;
  if (agent.data) {
    const { count, error } = await supabaseAdmin.from('documents').select('id', { count: 'exact', head: true }).eq('agent_id', agent.data.id).eq('noda_status', 'ready');
    if (error) return jsonError(UNREAD, 503);
    documents = count ?? 0;
  }
  const slug = (org.data as { slug?: string | null } | null)?.slug ?? null;
  const s = settings.data as Record<string, unknown> | null;
  return NextResponse.json({
    ok: true,
    data: {
      settings: {
        enabled: s?.enabled === true,
        enabledAt: (s?.enabled_at as string | null) ?? null,
        reason: (s?.enabled_reason as string | null) ?? null,
        notice: (s?.notice as string) ?? '',
        faq: (s?.faq as string[]) ?? [],
        contacts: readContacts(s?.contacts),
        allowedOrigins: (s?.allowed_origins as string[]) ?? [],
        ipDailyCap: (s?.ip_daily_cap as number) ?? PUBLIC_ASK_IP_CAP.default,
        orgDailyCap: (s?.org_daily_cap as number) ?? PUBLIC_ASK_ORG_CAP.default,
      },
      agent: agent.data ? { id: agent.data.id, name: agent.data.name, readyDocuments: documents } : null,
      slug,
      askUrl: slug ? `${APP_URL.replace(/\/+$/, '')}/ask/${slug}` : null,
      embed: slug ? embedSnippet(APP_URL, slug) : null,
      canManage: !session.user.isImpersonating,
    },
  });
}

export async function PUT(request: NextRequest) {
  const session = await getServerAuthSession();
  if (!session?.user?.id || !isAdminSession(session)) return jsonError('관리자 권한이 필요합니다.', 403);
  if (session.user.isImpersonating) return jsonError('대리 접근 중에는 시민 상담 창을 바꿀 수 없습니다.', 403);
  const actor = await actorScopeOr503(session);
  if (actor instanceof Response) return actor;
  if (!actor?.organizationId) return jsonError('소속 기관을 확인할 수 없습니다.', 403);
  if (!actor.managesWholeOrganization) return jsonError(WHOLE_ONLY, 403);
  const body = await readJsonObject(request);
  if (!body) return jsonError(BAD_BODY_MESSAGE, 400);
  const parsed = parsePublicAskSettings(body);
  if (!parsed.ok) return jsonError(parsed.message, 400);
  const v = parsed.value;

  const [org, agent, before] = await Promise.all([
    supabaseAdmin.from('organizations').select('slug').eq('id', actor.organizationId).maybeSingle(),
    supabaseAdmin.from('agents').select('id').eq('organization_id', actor.organizationId).eq('tier', 'public').is('deleted_at', null).maybeSingle(),
    supabaseAdmin.from('public_ask_settings').select('enabled').eq('organization_id', actor.organizationId).maybeSingle(),
  ]);
  if (org.error || agent.error || before.error) return jsonError(UNREAD, 503);
  if (v.enabled && !(org.data as { slug?: string | null } | null)?.slug) return jsonError('기관 로그인 경로(주소)가 없어 상담 주소를 만들 수 없습니다. 기관 정보에서 로그인 경로를 먼저 정해 주세요.', 400);
  if (v.enabled && !agent.data) return jsonError('시민 전용 비서를 먼저 만들어 주세요.', 400);

  const wasEnabled = (before.data as { enabled?: boolean } | null)?.enabled === true;
  const row = {
    organization_id: actor.organizationId,
    enabled: v.enabled,
    enabled_at: v.enabled ? new Date().toISOString() : null,
    enabled_reason: v.enabled ? v.reason : null,
    agent_id: agent.data?.id ?? null,
    notice: v.notice,
    faq: v.faq,
    contacts: v.contacts,
    allowed_origins: v.allowedOrigins,
    ip_daily_cap: v.ipDailyCap,
    org_daily_cap: v.orgDailyCap,
    updated_at: new Date().toISOString(),
    updated_by: session.user.id,
  };
  const { error } = await supabaseAdmin.from('public_ask_settings').upsert(row, { onConflict: 'organization_id' });
  if (error) return jsonError('시민 상담 설정을 저장하지 못했습니다. 잠시 뒤 다시 시도해 주세요.', 503);
  await logSecurityEvent(actor.departmentId, actor.userId, 'public_ask_changed', {
    enabled: v.enabled, ...(wasEnabled !== v.enabled ? { switched: v.enabled ? 'on' : 'off' } : {}), ...(v.reason ? { reason: v.reason } : {}),
    origins: v.allowedOrigins.length, ip_daily_cap: v.ipDailyCap, org_daily_cap: v.orgDailyCap,
  }, 'high');
  return NextResponse.json({ ok: true, data: { enabled: v.enabled } });
}
