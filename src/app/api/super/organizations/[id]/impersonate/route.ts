import { NextRequest, NextResponse } from 'next/server';
import { getSuperAdminFromRequest } from '@/lib/super-auth';
import { supabaseAdmin } from '@/lib/supabaseAdmin';
import { encode } from 'next-auth/jwt';
import { logSystem } from '@/lib/logger';
import { NEXTAUTH_SECRET, NEXTAUTH_URL } from '@/lib/config';
import { narrowImpersonationNotice, pickImpersonationTarget } from '@/lib/impersonation-target';

const IMPERSONATION_NOT_LOGGED = '대리 접근 기록을 남기지 못해 대리 접근을 내주지 않았습니다';

export const dynamic = 'force-dynamic';

function nextAuthCookieName() {
  const url = NEXTAUTH_URL ?? '';
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

  // 1) 기관 조회 — organizations 테이블에 slug 컬럼 없음, name만 선택
  const { data: org, error: orgErr } = await supabaseAdmin
    .from('organizations')
    .select('id, name')
    .eq('id', orgId)
    .maybeSingle();

  if (orgErr) {
    console.error('[impersonate] org query error:', orgErr.message, 'orgId:', orgId);
    return NextResponse.json({ ok: false, error: '기관을 불러오지 못했습니다. 잠시 뒤 다시 시도해 주세요.' }, { status: 500 });
  }
  if (!org) {
    return NextResponse.json({ ok: false, error: '기관을 찾을 수 없습니다.' }, { status: 404 });
  }

  // 2) 기관 소속 부서 조회 — 못 읽으면 '부서가 없습니다'가 아니라 그렇다고(2026-11-19)
  const { data: depts, error: deptErr } = await supabaseAdmin
    .from('departments')
    .select('id, name, parent_id')
    .eq('organization_id', orgId);

  if (deptErr) {
    console.error('[impersonate] dept query error:', deptErr.code);
    return NextResponse.json({ ok: false, error: '기관의 부서를 불러오지 못했습니다. 잠시 뒤 다시 시도해 주세요.' }, { status: 503 });
  }

  const deptIds = (depts ?? []).map((d: { id: string }) => d.id);
  if (!deptIds.length) {
    return NextResponse.json({ ok: false, error: '해당 기관에 부서가 없습니다.' }, { status: 404 });
  }

  // 3) 기관 소속 ADMIN 사용자 조회
  const { data: adminUsers, error: adminErr } = await supabaseAdmin
    .from('users')
    .select('id, email, full_name, department_id, created_at')
    .in('department_id', deptIds)
    .eq('role', 'ADMIN')
    .eq('is_super_admin', false)
    .eq('is_active', true) // 비활성·탈퇴한 관리자로 들어가지 않는다(2026-11-16 — 미들웨어가 바로 끊는다)
    .is('deleted_at', null)
    .order('created_at', { ascending: true })
    .limit(200);

  if (adminErr) {
    console.error('[impersonate] admin user query error:', adminErr.code);
    return NextResponse.json({ ok: false, error: '기관의 관리자를 불러오지 못했습니다. 잠시 뒤 다시 시도해 주세요.' }, { status: 503 });
  }

  // 최상위 부서의 관리자(= 기관 전체 관리자)를 먼저, 없으면 하위 부서 관리자로 들어가되 알린다(2026-11-19 —
  // 예전엔 가장 먼저 만든 관리자로 들어가 하위 부서 관리자면 그 부서 아래만 보였다)
  type AdminRow = { id: string; email: string; full_name: string | null; department_id: string | null; created_at: string | null };
  const pick = pickImpersonationTarget<AdminRow>((adminUsers ?? []) as AdminRow[], depts ?? [], admin.sub);
  if (!pick) {
    return NextResponse.json({ ok: false, error: '해당 기관에 관리자가 없습니다.' }, { status: 404 });
  }
  const adminUser = pick.user;

  // 4) impersonation_logs 기록
  const { data: logRow, error: logError } = await supabaseAdmin
    .from('impersonation_logs')
    .insert({
      super_admin_id: admin.sub,
      org_id: orgId,
      target_user_id: adminUser.id,
      ip_address: request.headers.get('x-forwarded-for') ?? null,
    })
    .select('id')
    .maybeSingle();
  // 기록 없는 대리 접근은 내주지 않는다(2026-11-17) — 예전엔 기록이 실패해도 들어가, 감사 '대리 접근 이력'에 없는 접근이 생겼다
  if (logError || !logRow?.id) {
    await logSystem({ level: 'error', category: 'security', message: IMPERSONATION_NOT_LOGGED, details: { superAdminId: admin.sub, code: logError?.code ?? 'no_row' }, orgId });
    return NextResponse.json({ ok: false, error: '대리 접근 기록을 남기지 못해 들어가지 않았습니다. 잠시 뒤 다시 시도해 주세요.' }, { status: 503 });
  }

  // 5) NextAuth 호환 임시 세션 토큰 생성 (2시간)
  // 예전엔 환경 변수가 비면 소스에 적힌 고정 값으로 서명했다(2026-11-16 — config.ts가 값이 없으면 시작에서 멈춘다)
  const secret = NEXTAUTH_SECRET;
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
      impersonateLogId: logRow.id,
      iat: Math.floor(Date.now() / 1000),
      exp: Math.floor(Date.now() / 1000) + 7200,
    },
    secret,
    maxAge: 7200,
  });

  // 6) 응답 — 쿠키 설정
  const isProd = (NEXTAUTH_URL ?? '').startsWith('https://');
  const response = NextResponse.json({
    ok: true,
    data: { redirectUrl: '/admin', orgName: org.name, wholeOrganization: pick.wholeOrganization },
    ...(pick.wholeOrganization ? {} : { warning: narrowImpersonationNotice(pick.departmentName) }),
  });
  response.cookies.set({
    name: nextAuthCookieName(),
    value: sessionToken,
    httpOnly: true,
    secure: isProd,
    sameSite: 'lax',
    path: '/',
    maxAge: 7200,
  });

  logSystem({ level: 'warning', category: 'security',
    message: `대리 접근: ${org.name}`,
    details: { superAdminId: admin.sub, targetUserId: adminUser.id, wholeOrganization: pick.wholeOrganization },
    orgId });

  return response;
}
