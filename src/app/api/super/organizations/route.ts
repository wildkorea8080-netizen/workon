import { NextRequest, NextResponse } from 'next/server';
import { getSuperAdminFromRequest } from '@/lib/super-auth';
import { supabaseAdmin } from '@/lib/supabaseAdmin';
import crypto from 'crypto';
import { logSystem } from '@/lib/logger';

export const dynamic = 'force-dynamic';

// ── GET: 기관 목록 조회 ──────────────────────────────────────
export async function GET(request: NextRequest) {
  const admin = getSuperAdminFromRequest(request);
  if (!admin) return NextResponse.json({ ok: false, error: '인증 필요' }, { status: 401 });

  const { searchParams } = new URL(request.url);
  const search = searchParams.get('search') ?? '';
  const status = searchParams.get('status') ?? 'all';
  const plan   = searchParams.get('plan')   ?? 'all';
  const page   = Math.max(1, parseInt(searchParams.get('page')  ?? '1'));
  const limit  = Math.min(100, parseInt(searchParams.get('limit') ?? '20'));

  try {
    let query = supabaseAdmin
      .from('v_organization_summary')
      .select('*', { count: 'exact' });

    if (search)              query = query.ilike('name', `%${search}%`);
    if (status !== 'all')    query = query.eq('status', status);
    if (plan   !== 'all')    query = query.eq('plan', plan);

    const { data, count, error } = await query
      .order('created_at', { ascending: false })
      .range((page - 1) * limit, page * limit - 1);

    if (error) throw error;

    // 만료까지 남은 일수 계산
    const now = Date.now();
    const orgs = (data ?? []).map((o: any) => {
      let daysLeft: number | null = null;
      if (o.contract_expires_at) {
        daysLeft = Math.ceil((new Date(o.contract_expires_at).getTime() - now) / 86400000);
      }
      return { ...o, days_until_expiry: daysLeft };
    });

    return NextResponse.json({
      ok: true,
      data: orgs,
      meta: { total: count ?? 0, page, limit },
    });
  } catch (err: any) {
    // v_organization_summary 뷰 없을 경우 직접 쿼리 fallback
    try {
      let q = supabaseAdmin
        .from('organizations')
        .select('id, name, slug, type, status, plan, domain, contact_name, contact_email, max_users, max_agents, monthly_token_limit, notes, created_at', { count: 'exact' });

      if (search)           q = q.ilike('name', `%${search}%`);
      if (status !== 'all') q = q.eq('status', status);
      if (plan   !== 'all') q = q.eq('plan', plan);

      const { data, count } = await q
        .order('created_at', { ascending: false })
        .range((page - 1) * limit, page * limit - 1);

      return NextResponse.json({
        ok: true,
        data: data ?? [],
        meta: { total: count ?? 0, page, limit },
      });
    } catch (fallbackErr: any) {
      console.error('[super/organizations GET]', fallbackErr);
      return NextResponse.json({ ok: false, error: fallbackErr.message }, { status: 500 });
    }
  }
}

// ── POST: 신규 기관 등록 ─────────────────────────────────────
export async function POST(request: NextRequest) {
  const admin = getSuperAdminFromRequest(request);
  if (!admin) return NextResponse.json({ ok: false, error: '인증 필요' }, { status: 401 });

  try {
    const body = await request.json();
    const {
      name, slug, type, plan,
      contractStart, contractEnd,
      maxUsers, maxAgents, maxTokensPerMonth,
      adminEmail,
      monthlyFee, notes,
    } = body;

    if (!name || !slug || !adminEmail) {
      return NextResponse.json(
        { ok: false, error: '기관명, Slug, 관리자 이메일은 필수입니다.' },
        { status: 400 }
      );
    }

    // slug 형식 검증
    if (!/^[a-z0-9-]+$/.test(slug)) {
      return NextResponse.json(
        { ok: false, error: 'Slug는 영문 소문자, 숫자, 하이픈만 사용 가능합니다.' },
        { status: 400 }
      );
    }

    // slug 중복 확인 (departments 테이블에서 확인)
    const { data: existingDept } = await supabaseAdmin
      .from('departments')
      .select('id')
      .eq('slug', `${slug}-main`)
      .maybeSingle();

    if (existingDept) {
      return NextResponse.json(
        { ok: false, error: '이미 사용 중인 Slug입니다.' },
        { status: 409 }
      );
    }

    // 1) organizations INSERT (slug 컬럼은 organizations 테이블에 없음 → departments에서 사용)
    const { data: org, error: orgError } = await supabaseAdmin
      .from('organizations')
      .insert({
        name: name.trim(),
        type: type ?? '공공기관',
        status: 'active',
        plan: plan ?? 'basic',
        max_users: maxUsers ?? 20,
        max_agents: maxAgents ?? 10,
        monthly_token_limit: maxTokensPerMonth ?? 2000000,
        notes: notes ?? null,
      })
      .select()
      .single();

    if (orgError || !org) throw new Error(orgError?.message ?? '기관 생성 실패');

    // 2) contracts INSERT
    const { error: contractError } = await supabaseAdmin
      .from('contracts')
      .insert({
        organization_id: org.id,
        plan: plan ?? 'basic',
        status: 'active',
        started_at: contractStart ? new Date(contractStart).toISOString() : new Date().toISOString(),
        expires_at: contractEnd   ? new Date(contractEnd).toISOString()   : null,
        max_users: maxUsers ?? 20,
        max_agents: maxAgents ?? 10,
        monthly_token_limit: maxTokensPerMonth ?? 2000000,
        price_per_month: monthlyFee ?? 0,
        created_by: admin.sub,
      });

    if (contractError) console.warn('[contracts insert]', contractError.message);

    // 3) 관리자 초대 토큰 생성 (invitations INSERT)
    //    먼저 기관에 기본 부서 생성
    const { data: dept } = await supabaseAdmin
      .from('departments')
      .insert({
        name: `${name.trim()} 본청`,
        slug: `${slug}-main`,
        description: `${name.trim()} 기본 부서`,
        organization_id: org.id,
      })
      .select('id')
      .single();

    const inviteToken = crypto.randomBytes(32).toString('hex');
    const baseUrl = process.env.NEXTAUTH_URL ?? 'https://workon-ai.vercel.app';

    await supabaseAdmin.from('invitations').insert({
      email: adminEmail.trim().toLowerCase(),
      department_id: dept?.id ?? null,
      role: 'ADMIN',
      token: inviteToken,
      invited_by: admin.sub,
      expires_at: new Date(Date.now() + 7 * 86400000).toISOString(),
    });

    const inviteUrl = `${baseUrl}/signup?invite=${inviteToken}`;

    // 슈퍼관리자 로그 기록
    await supabaseAdmin.from('super_admin_logs').insert({
      admin_user_id: admin.sub,
      action: 'org_created',
      target_type: 'organization',
      target_id: org.id,
      after_data: { name: org.name, plan, adminEmail },
    });
    logSystem({ level: 'info', category: 'admin',
      message: `기관 등록: ${org.name}`, details: { plan, adminEmail }, orgId: org.id });

    return NextResponse.json({
      ok: true,
      data: { org, inviteUrl },
    });
  } catch (err: any) {
    console.error('[super/organizations POST]', err);
    return NextResponse.json({ ok: false, error: err.message }, { status: 500 });
  }
}
