import { NextRequest, NextResponse } from 'next/server';
import { getSuperAdminFromRequest } from '@/lib/super-auth';
import { supabaseAdmin } from '@/lib/supabaseAdmin';
import { createSupabaseWorkStore } from '@/lib/work/store/supabase';

export const dynamic = 'force-dynamic';

const unauthorized = () => NextResponse.json({ ok: false, error: { message: '슈퍼관리자 인증이 필요합니다.' } }, { status: 401 });

/** 기관별 업무 화면 스위치(업무 홈·새 작업) — 기관 목록과 함께 */
export async function GET(request: NextRequest) {
  const admin = getSuperAdminFromRequest(request);
  if (!admin) return unauthorized();
  const [orgs, settings] = await Promise.all([
    supabaseAdmin.from('organizations').select('id, name, status').order('name'),
    supabaseAdmin.from('work_org_settings').select('organization_id, home_enabled, new_tasks_enabled, updated_at'),
  ]);
  if (orgs.error || settings.error) return NextResponse.json({ ok: false, error: { message: '목록을 불러오지 못했습니다.' } }, { status: 500 });
  const by = new Map(((settings.data ?? []) as { organization_id: string; home_enabled: boolean; new_tasks_enabled: boolean; updated_at: string }[]).map((s) => [s.organization_id, s]));
  return NextResponse.json({
    ok: true,
    data: ((orgs.data ?? []) as { id: string; name: string; status: string }[]).map((o) => ({
      id: o.id,
      name: o.name,
      status: o.status,
      homeEnabled: by.get(o.id)?.home_enabled ?? false,
      newTasksEnabled: by.get(o.id)?.new_tasks_enabled ?? false,
      updatedAt: by.get(o.id)?.updated_at ?? null,
    })),
  });
}

/**
 * { organizationId, homeEnabled, newTasksEnabled } — 대표 기관부터 켠다(06 문서 M3·M5).
 * 끄면 홈은 대화로 돌아가고 새 작업은 막히지만 이미 만든 작업·파일은 읽기·내려받기가 남는다. 바꾼 기록은 super_admin_logs
 */
export async function PATCH(request: NextRequest) {
  const admin = getSuperAdminFromRequest(request);
  if (!admin) return unauthorized();
  const body = (await request.json().catch(() => null)) as { organizationId?: unknown; homeEnabled?: unknown; newTasksEnabled?: unknown } | null;
  if (!body || typeof body.organizationId !== 'string' || !/^[0-9a-f-]{36}$/i.test(body.organizationId) || typeof body.homeEnabled !== 'boolean' || typeof body.newTasksEnabled !== 'boolean') {
    return NextResponse.json({ ok: false, error: { message: '요청 형식이 올바르지 않습니다.' } }, { status: 400 });
  }
  const { data: org } = await supabaseAdmin.from('organizations').select('id').eq('id', body.organizationId).maybeSingle();
  if (!org) return NextResponse.json({ ok: false, error: { message: '기관을 찾을 수 없습니다.' } }, { status: 404 });
  const store = createSupabaseWorkStore();
  const before = await store.getOrgSettings(body.organizationId);
  // updated_by는 기관 사용자 칸이라 슈퍼관리자 id는 기록(super_admin_logs)에만 남긴다
  const after = await store.upsertOrgSettings(body.organizationId, { homeEnabled: body.homeEnabled, newTasksEnabled: body.newTasksEnabled, updatedBy: null });
  await supabaseAdmin.from('super_admin_logs').insert({
    admin_user_id: admin.sub,
    action: 'work_settings_changed',
    target_type: 'organization',
    target_id: body.organizationId,
    before_data: before,
    after_data: after,
  });
  return NextResponse.json({ ok: true, data: after });
}
