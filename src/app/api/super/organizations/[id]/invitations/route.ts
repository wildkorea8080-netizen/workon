import { NextRequest, NextResponse } from 'next/server';
import { getSuperAdminFromRequest } from '@/lib/super-auth';
import { supabaseAdmin } from '@/lib/supabaseAdmin';
import crypto from 'crypto';
import { dbErrorText } from '@/lib/db-error-text';
import { writeAuditRow } from '@/lib/audit-write';
import { APP_URL } from '@/lib/config';

export const dynamic = 'force-dynamic';

// GET: 기관의 초대 링크 목록
export async function GET(request: NextRequest, { params }: { params: { id: string } }) {
  if (!getSuperAdminFromRequest(request))
    return NextResponse.json({ ok: false, error: '인증 필요' }, { status: 401 });

  const { data: depts } = await supabaseAdmin
    .from('departments').select('id').eq('organization_id', params.id);

  const deptIds = (depts ?? []).map((d: { id: string }) => d.id);
  if (!deptIds.length) return NextResponse.json({ ok: true, data: [] });

  const { data, error } = await supabaseAdmin
    .from('invitations')
    .select('id, email, role, token, expires_at, accepted_at, created_at')
    .in('department_id', deptIds)
    .order('created_at', { ascending: false });

  if (error) return NextResponse.json({ ok: false, error: dbErrorText(error) }, { status: 500 });

  const baseUrl = APP_URL;
  const result = (data ?? []).map((inv: any) => ({
    ...inv,
    inviteUrl: `${baseUrl}/signup?invite=${inv.token}`,
    isExpired: new Date(inv.expires_at) < new Date(),
    isAccepted: !!inv.accepted_at,
  }));

  return NextResponse.json({ ok: true, data: result });
}

// POST: 초대 링크 재생성
export async function POST(request: NextRequest, { params }: { params: { id: string } }) {
  const admin = getSuperAdminFromRequest(request);
  if (!admin) return NextResponse.json({ ok: false, error: '인증 필요' }, { status: 401 });

  const body = (await request.json().catch(() => null)) as { email?: unknown; role?: unknown } | null;
  const email = typeof body?.email === 'string' ? body.email.trim().toLowerCase() : '';
  const role = body?.role === undefined ? 'ADMIN' : body.role;
  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return NextResponse.json({ ok: false, error: '초대할 이메일을 확인해 주세요.' }, { status: 400 });
  // 역할은 둘 중 하나만(2026-11-17 — 예전엔 아무 글이나 초대 역할로 저장했다)
  if (role !== 'ADMIN' && role !== 'USER') return NextResponse.json({ ok: false, error: '역할은 ADMIN 또는 USER만 됩니다.' }, { status: 400 });

  // 기관의 최상위 부서(가장 먼저 만든 것)로 — 예전엔 아무 부서 하나(순서 없음)였고, 부서가 없으면 소속 없는 초대를 만들어
  // 가입에서 거절됐다(2026-11-12부터 소속 없는 초대는 거절)
  const { data: depts, error: deptErr } = await supabaseAdmin
    .from('departments').select('id').eq('organization_id', params.id).is('parent_id', null)
    .order('created_at', { ascending: true }).limit(1);
  if (deptErr) return NextResponse.json({ ok: false, error: dbErrorText(deptErr) }, { status: 500 });
  const deptId = depts?.[0]?.id ?? null;
  if (!deptId) return NextResponse.json({ ok: false, error: '이 기관에 부서가 없어 초대 링크를 만들 수 없습니다.' }, { status: 400 });

  const token  = crypto.randomBytes(32).toString('hex');
  const baseUrl = APP_URL;

  const { data, error } = await supabaseAdmin.from('invitations').insert({
    email,
    department_id: deptId,
    role,
    token,
    invited_by: admin.sub,
    expires_at: new Date(Date.now() + 7 * 86400000).toISOString(),
  }).select().single();

  if (error) return NextResponse.json({ ok: false, error: dbErrorText(error) }, { status: 500 });

  // 조작 기록(2026-11-17) — 초대 열쇠는 남기지 않는다
  await writeAuditRow('super_admin_logs', {
    admin_user_id: admin.sub,
    action: 'invitation_created',
    target_type: 'organization',
    target_id: params.id,
    after_data: { email, role },
  }, 'invitation_created');

  return NextResponse.json({
    ok: true,
    data: { ...data, inviteUrl: `${baseUrl}/signup?invite=${token}` },
  });
}
