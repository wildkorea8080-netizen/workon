import { NextRequest, NextResponse } from 'next/server';
import { getSuperAdminFromRequest } from '@/lib/super-auth';
import { supabaseAdmin } from '@/lib/supabaseAdmin';
import { encode } from 'next-auth/jwt';

export const dynamic = 'force-dynamic';

function nextAuthCookieName() {
  const url = process.env.NEXTAUTH_URL ?? '';
  return url.startsWith('https://')
    ? '__Secure-next-auth.session-token'
    : 'next-auth.session-token';
}

export async function POST(
  request: NextRequest,
  { params }: { params: { id: string } }
) {
  const admin = getSuperAdminFromRequest(request);
  if (!admin) return NextResponse.json({ ok: false, error: '인증 필요' }, { status: 401 });

  const orgId = params.id;

  // 1) 기관 조회
  const { data: org } = await supabaseAdmin
    .from('organizations')
    .select('id, name, slug')
    .eq('id', orgId)
    .single();

  if (!org) return NextResponse.json({ ok: false, error: '기관을 찾을 수 없습니다.' }, { status: 404 });

  // 2) 기관 소속 ADMIN 사용자 조회
  const { data: depts } = await supabaseAdmin
    .from('departments')
    .select('id')
    .eq('organization_id', orgId);

  const deptIds = (depts ?? []).map(d => d.id);
  if (!deptIds.length) {
    return NextResponse.json({ ok: false, error: '해당 기관에 부서가 없습니다.' }, { status: 404 });
  }

  const { data: adminUser } = await supabaseAdmin
    .from('users')
    .select('id, email, full_name, department_id')
    .in('department_id', deptIds)
    .eq('role', 'ADMIN')
    .maybeSingle();

  if (!adminUser) {
    return NextResponse.json({ ok: false, error: '해당 기관에 관리자가 없습니다.' }, { status: 404 });
  }

  // 3) impersonation_logs 기록
  const { data: logRow } = await supabaseAdmin
    .from('impersonation_logs')
    .insert({
      super_admin_id: admin.sub,
      org_id: orgId,
      target_user_id: adminUser.id,
      ip_address: request.headers.get('x-forwarded-for') ?? null,
    })
    .select('id')
    .single();

  // 4) NextAuth 호환 임시 세션 토큰 생성 (2시간)
  const secret = process.env.NEXTAUTH_SECRET ?? 'fallback-secret';
  const sessionToken = await encode({
    token: {
      sub: adminUser.id,
      id: adminUser.id,
      name: adminUser.full_name ?? adminUser.email,
      email: adminUser.email,
      role: 'ADMIN',
      departmentId: adminUser.department_id,
      isImpersonating: true,
      impersonatedBy: admin.sub,
      impersonateOrgId: orgId,
      impersonateOrgName: org.name,
      impersonateLogId: logRow?.id ?? '',
      iat: Math.floor(Date.now() / 1000),
      exp: Math.floor(Date.now() / 1000) + 7200,
    },
    secret,
    maxAge: 7200,
  });

  // 5) 응답 - 쿠키 설정
  const response = NextResponse.json({
    ok: true,
    data: { redirectUrl: '/admin', orgName: org.name },
  });

  const isProd = (process.env.NEXTAUTH_URL ?? '').startsWith('https://');
  response.cookies.set({
    name: nextAuthCookieName(),
    value: sessionToken,
    httpOnly: true,
    secure: isProd,
    sameSite: 'lax',
    path: '/',
    maxAge: 7200,
  });

  return response;
}
