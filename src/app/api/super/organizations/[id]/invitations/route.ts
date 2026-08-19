import { NextRequest, NextResponse } from 'next/server';
import { getSuperAdminFromRequest } from '@/lib/super-auth';
import { supabaseAdmin } from '@/lib/supabaseAdmin';
import crypto from 'crypto';

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

  if (error) return NextResponse.json({ ok: false, error: error.message }, { status: 500 });

  const baseUrl = process.env.NEXTAUTH_URL ?? 'https://workon-ai.vercel.app';
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

  const { email, role = 'ADMIN' } = await request.json();
  if (!email) return NextResponse.json({ ok: false, error: 'email 필수' }, { status: 400 });

  const { data: depts } = await supabaseAdmin
    .from('departments').select('id').eq('organization_id', params.id).limit(1);

  const deptId = depts?.[0]?.id ?? null;
  const token  = crypto.randomBytes(32).toString('hex');
  const baseUrl = process.env.NEXTAUTH_URL ?? 'https://workon-ai.vercel.app';

  const { data, error } = await supabaseAdmin.from('invitations').insert({
    email: email.trim().toLowerCase(),
    department_id: deptId,
    role,
    token,
    invited_by: admin.sub,
    expires_at: new Date(Date.now() + 7 * 86400000).toISOString(),
  }).select().single();

  if (error) return NextResponse.json({ ok: false, error: error.message }, { status: 500 });

  return NextResponse.json({
    ok: true,
    data: { ...data, inviteUrl: `${baseUrl}/signup?invite=${token}` },
  });
}
