import { NextRequest, NextResponse } from 'next/server';
import { getSuperAdminFromRequest } from '@/lib/super-auth';
import { supabaseAdmin } from '@/lib/supabaseAdmin';
import { adminLogActionLabel, adminLogSummary, adminLogTargetLabel, isAdminLogAction } from '@/lib/super-admin-log-spec';

export const dynamic = 'force-dynamic';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

interface Row {
  id: string;
  action: string;
  target_type: string | null;
  target_id: string | null;
  before_data: unknown;
  after_data: unknown;
  ip_address: string | null;
  created_at: string;
  users: { email: string | null; full_name: string | null } | Array<{ email: string | null; full_name: string | null }> | null;
}

/**
 * 슈퍼관리자 조작 기록(2026-11-17) — `super_admin_logs`를 최근 것부터. 대상 기관·계정은 이름·이메일을 붙인다.
 * `?page=&limit=`(100까지), `?action=`(종류 하나). 못 읽으면 503(빈 목록으로 꾸미지 않음)
 */
export async function GET(request: NextRequest) {
  if (!getSuperAdminFromRequest(request))
    return NextResponse.json({ ok: false, error: { message: '인증 필요' } }, { status: 401 });

  const sp = new URL(request.url).searchParams;
  const page = Math.max(1, parseInt(sp.get('page') ?? '1', 10) || 1);
  const limit = Math.min(100, Math.max(1, parseInt(sp.get('limit') ?? '50', 10) || 50));
  const action = sp.get('action');

  let q = supabaseAdmin
    .from('super_admin_logs')
    .select(
      'id, action, target_type, target_id, before_data, after_data, ip_address, created_at, users!super_admin_logs_admin_user_id_fkey(email, full_name)',
      { count: 'exact' },
    )
    .order('created_at', { ascending: false })
    .range((page - 1) * limit, page * limit - 1);
  if (isAdminLogAction(action)) q = q.eq('action', action);

  const { data, count, error } = await q;
  if (error) {
    console.error('[super/logs/admin GET]', error.code);
    return NextResponse.json({ ok: false, error: { message: '조작 기록을 불러오지 못했습니다. 잠시 뒤 다시 시도해 주세요.' } }, { status: 503 });
  }
  const rows = (data ?? []) as unknown as Row[];

  // 대상 이름 — 기관·계정만, 못 읽으면 id 앞부분
  const idsOf = (type: string) => Array.from(new Set(rows.filter((r) => r.target_type === type && r.target_id && UUID.test(r.target_id)).map((r) => r.target_id as string)));
  const userIds = idsOf('user');
  const contractIds = idsOf('contract');
  // 계약은 그 계약의 기관 이름으로
  const contracts = contractIds.length
    ? await supabaseAdmin.from('contracts').select('id, organization_id').in('id', contractIds)
    : { data: [] as Array<{ id: string; organization_id: string | null }> };
  const contractOrg = new Map(((contracts.data ?? []) as Array<{ id: string; organization_id: string | null }>).map((c) => [c.id, c.organization_id]));
  const orgIds = Array.from(new Set([...idsOf('organization'), ...Array.from(contractOrg.values()).filter((v): v is string => !!v)]));
  const [orgs, users] = await Promise.all([
    orgIds.length ? supabaseAdmin.from('organizations').select('id, name').in('id', orgIds) : Promise.resolve({ data: [] as Array<{ id: string; name: string | null }> }),
    userIds.length ? supabaseAdmin.from('users').select('id, email, full_name').in('id', userIds) : Promise.resolve({ data: [] as Array<{ id: string; email: string | null; full_name: string | null }> }),
  ]);
  const orgName = new Map(((orgs.data ?? []) as Array<{ id: string; name: string | null }>).map((o) => [o.id, o.name ?? '']));
  const userName = new Map(((users.data ?? []) as Array<{ id: string; email: string | null; full_name: string | null }>).map((u) => [u.id, u.full_name ? `${u.full_name} (${u.email ?? ''})` : u.email ?? '']));

  const out = rows.map((r) => {
    const admin = Array.isArray(r.users) ? r.users[0] : r.users;
    const contractOrgId = r.target_type === 'contract' && r.target_id ? contractOrg.get(r.target_id) : undefined;
    const name = r.target_id
      ? r.target_type === 'organization' ? orgName.get(r.target_id)
        : r.target_type === 'user' ? userName.get(r.target_id)
          : contractOrgId ? orgName.get(contractOrgId)
            : undefined
      : undefined;
    return {
      id: r.id,
      createdAt: r.created_at,
      action: r.action,
      actionLabel: adminLogActionLabel(r.action),
      targetType: r.target_type,
      targetLabel: adminLogTargetLabel(r.target_type),
      targetId: r.target_id,
      // 공지는 요약에 제목이 있어 id를 보이지 않는다
      targetName: name || (r.target_id && r.target_type !== 'notice' ? `${r.target_id.slice(0, 8)}…` : null),
      summary: adminLogSummary(r.action, r.before_data, r.after_data),
      adminEmail: admin?.email ?? '—',
      adminName: admin?.full_name ?? '—',
      ipAddress: r.ip_address,
    };
  });

  return NextResponse.json({ ok: true, data: out, meta: { total: count ?? 0, page, limit } });
}
