import { NextResponse } from 'next/server';
import { getServerAuthSession, isAdminSession } from '@/lib/auth';
import { getActorScope } from '@/lib/actor-scope';
import { supabaseAdmin } from '@/lib/supabaseAdmin';
import { installChosenPresets, presetStatus } from '@/lib/preset-install-admin';

export const dynamic = 'force-dynamic';

function jsonError(message: string, status: number) {
  return NextResponse.json({ ok: false, error: { message } }, { status });
}

async function organizationType(organizationId: string): Promise<{ ok: true; type: string | null } | { ok: false }> {
  const { data, error } = await supabaseAdmin.from('organizations').select('type').eq('id', organizationId).maybeSingle();
  if (error) return { ok: false };
  const type = (data as { type?: unknown } | null)?.type;
  return { ok: true, type: typeof type === 'string' ? type : null };
}

/**
 * 기본 비서·앱 세트(2026-11-07) — 이 기관에 깔린 것과 아직 없는 것. 관리자는 누구나 본다(설치는 기관 전체 관리자만)
 */
export async function GET() {
  const session = await getServerAuthSession();
  if (!isAdminSession(session)) return jsonError('관리자 권한이 필요합니다.', 403);
  const actor = await getActorScope(session!);
  if (!actor?.organizationId) return jsonError('소속 기관을 찾을 수 없습니다.', 403);
  const org = await organizationType(actor.organizationId);
  if (!org.ok) return jsonError('기본 세트를 지금 불러올 수 없습니다. 잠시 뒤 다시 시도해 주세요.', 503);
  try {
    const items = await presetStatus(actor.organizationId, org.type);
    return NextResponse.json({ ok: true, data: { items, canInstall: actor.managesWholeOrganization } });
  } catch {
    return jsonError('기본 세트를 지금 불러올 수 없습니다. 잠시 뒤 다시 시도해 주세요.', 503);
  }
}

/**
 * 고른 기본 비서·앱을 설치한다 — 기관 전체 관리자만(설치한 비서가 기관 전체에 공개된다). 이미 있는 이름은 건너뛴다.
 * `security_logs`에 설치한 이름을 남긴다(기관 전체에 보이는 비서가 늘어나는 일이라)
 */
export async function POST(request: Request) {
  const session = await getServerAuthSession();
  if (!isAdminSession(session)) return jsonError('관리자 권한이 필요합니다.', 403);
  const actor = await getActorScope(session!);
  if (!actor?.organizationId) return jsonError('소속 기관을 찾을 수 없습니다.', 403);
  if (!actor.managesWholeOrganization) return jsonError('기관 전체를 관리하는 관리자만 기본 세트를 설치할 수 있습니다.', 403);

  const body = (await request.json().catch(() => null)) as { names?: unknown } | null;
  const names = body?.names;
  if (!Array.isArray(names) || names.length > 50 || names.some((n) => typeof n !== 'string')) return jsonError('설치할 비서·앱 이름 목록을 보내 주세요.', 400);

  const org = await organizationType(actor.organizationId);
  if (!org.ok) return jsonError('기본 세트를 지금 설치할 수 없습니다. 잠시 뒤 다시 시도해 주세요.', 503);
  try {
    const result = await installChosenPresets({ organizationId: actor.organizationId, organizationType: org.type, departmentId: actor.departmentId, names: names as string[] });
    if (!result.ok) return jsonError(result.message, 400);
    if (result.installed.length) {
      await supabaseAdmin.from('security_logs').insert({
        department_id: actor.departmentId,
        user_id: actor.userId,
        event_type: 'preset_agents_installed',
        severity: 'low',
        details: { names: result.installed, failed: result.failed },
      });
    }
    return NextResponse.json({ ok: true, data: { installed: result.installed, skipped: result.skipped, failed: result.failed } });
  } catch {
    return jsonError('기본 세트를 지금 설치할 수 없습니다. 잠시 뒤 다시 시도해 주세요.', 503);
  }
}
