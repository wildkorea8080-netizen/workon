import { NextRequest, NextResponse } from 'next/server';
import { installPresetAgents } from '@/lib/install-presets';
import { getSuperAdminFromRequest } from '@/lib/super-auth';
import { supabaseAdmin } from '@/lib/supabaseAdmin';
import crypto from 'crypto';
import { logSystem } from '@/lib/logger';
import { writeAuditRow } from '@/lib/audit-write';
import { reportContractSync } from '@/lib/contract-sync';
import { dbErrorText } from '@/lib/db-error-text';
import { APP_URL } from '@/lib/config';
import { normalizeOrgSlug } from '@/lib/org-slug';
import { orgChatTokens } from '@/lib/org-chat-tokens';
import { kstMonthStart } from '@/lib/kst-time';
import { searchTerm } from '@/lib/postgrest-search';

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

    if (searchTerm(search))  query = query.ilike('name', `%${searchTerm(search)}%`);
    if (status !== 'all')    query = query.eq('status', status);
    if (plan   !== 'all')    query = query.eq('plan', plan);

    const { data, count, error } = await query
      .order('created_at', { ascending: false })
      .range((page - 1) * limit, page * limit - 1);

    if (error) throw error;

    // 이번 달 토큰은 한도 판정과 같은 셈(chat_message·한국 시간 이번 달 — `org-chat-tokens.ts`). 뷰의 값은 모든 활동·UTC 달이라 기관 상세와 달랐다(2026-11-17)
    const tokens = await orgChatTokens((data ?? []).map((o: { id: string }) => o.id), kstMonthStart().toISOString());

    // 만료까지 남은 일수 계산
    const now = Date.now();
    const orgs = (data ?? []).map((o: any) => {
      let daysLeft: number | null = null;
      if (o.contract_expires_at) {
        daysLeft = Math.ceil((new Date(o.contract_expires_at).getTime() - now) / 86400000);
      }
      return { ...o, tokens_this_month: tokens.has(o.id) ? tokens.get(o.id) : null, days_until_expiry: daysLeft };
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

      if (searchTerm(search)) q = q.ilike('name', `%${searchTerm(search)}%`);
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
      return NextResponse.json({ ok: false, error: dbErrorText(fallbackErr) }, { status: 500 });
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

    // slug 형식 — 기관 관리자 '기관 정보'와 같은 규칙(2026-11-17, `org-slug.ts`)
    const slugCheck = normalizeOrgSlug(slug);
    if (!slugCheck.ok) {
      return NextResponse.json({ ok: false, error: slugCheck.message }, { status: 400 });
    }
    const orgSlug = slugCheck.slug;

    // slug 중복 — 기관 로그인 경로(organizations.slug, 0020 유일)와 기본 부서 slug 둘 다
    const [{ data: existingOrg, error: orgSlugErr }, { data: existingDept, error: deptSlugErr }] = await Promise.all([
      supabaseAdmin.from('organizations').select('id').eq('slug', orgSlug).maybeSingle(),
      supabaseAdmin.from('departments').select('id').eq('slug', `${orgSlug}-main`).maybeSingle(),
    ]);
    if (orgSlugErr || deptSlugErr) {
      return NextResponse.json({ ok: false, error: dbErrorText(orgSlugErr ?? deptSlugErr) }, { status: 500 });
    }

    if (existingOrg || existingDept) {
      return NextResponse.json(
        { ok: false, error: '이미 사용 중인 Slug입니다.' },
        { status: 409 }
      );
    }

    // 1) organizations INSERT — slug는 기관 전용 로그인 경로(/signin/{slug}, 0020). 예전엔 기관에 저장하지 않아 새 기관은 로그인 경로가 없었다
    const { data: org, error: orgError } = await supabaseAdmin
      .from('organizations')
      .insert({
        name: name.trim(),
        slug: orgSlug,
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

    if (orgError || !org) throw orgError ?? new Error('기관 생성 실패');

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
    // 못 만들면 기본 비서·관리자 초대가 빠진다 — 예전엔 소속 없는 초대를 만들어(가입에서 거절됨) 동작하지 않는 링크를 돌려줬다(2026-11-17)
    const { data: dept, error: deptError } = await supabaseAdmin
      .from('departments')
      .insert({
        name: `${name.trim()} 본청`,
        slug: `${orgSlug}-main`,
        description: `${name.trim()} 기본 부서`,
        organization_id: org.id,
      })
      .select('id')
      .single();

    // 기관 유형에 맞는 기본 비서 세트를 깐다. 새 기관이 빈 화면에서
    // 시작하면 무엇부터 해야 할지 알 수 없다.
    // 실패해도 기관 생성 자체는 유지한다 — 비서는 나중에 다시 깔 수 있다.
    let presetResult = { installed: 0, skipped: 0, categories: 0 };
    if (dept?.id) {
      try {
        presetResult = await installPresetAgents(org.id, dept.id, org.type);
      } catch (presetError: any) {
        console.warn('[org create] 기본 비서 설치 실패:', presetError?.message);
      }
    }

    const inviteToken = crypto.randomBytes(32).toString('hex');
    const baseUrl = APP_URL;

    // 초대를 저장하지 못하면 링크가 동작하지 않는다 — 예전에는 그래도 링크를 돌려줘 기관 관리자가 가입할 수 없었다(2026-11-17)
    let inviteWarning: string | undefined;
    let inviteUrl: string | null = null;
    if (!dept?.id) {
      inviteWarning = await reportContractSync('org_default_department', org.id, deptError?.code ?? 'no_row');
    } else {
      const { error: inviteErr } = await supabaseAdmin.from('invitations').insert({
        email: adminEmail.trim().toLowerCase(),
        department_id: dept.id,
        role: 'ADMIN',
        token: inviteToken,
        invited_by: admin.sub,
        expires_at: new Date(Date.now() + 7 * 86400000).toISOString(),
      });
      if (inviteErr) inviteWarning = await reportContractSync('org_admin_invitation', org.id, inviteErr.code ?? 'error');
      else inviteUrl = `${baseUrl}/signup?invite=${inviteToken}`;
    }

    // 슈퍼관리자 로그 기록
    await writeAuditRow('super_admin_logs', {
      admin_user_id: admin.sub,
      action: 'org_created',
      target_type: 'organization',
      target_id: org.id,
      after_data: { name: org.name, plan, adminEmail, presetAgents: presetResult.installed },
    }, 'org_created');
    logSystem({ level: 'info', category: 'admin',
      message: `기관 등록: ${org.name}`, details: { plan, adminEmail }, orgId: org.id });

    return NextResponse.json({
      ok: true,
      data: { org, inviteUrl, presetAgents: presetResult.installed },
      ...(inviteWarning ? { warning: inviteWarning } : {}),
    });
  } catch (err: any) {
    console.error('[super/organizations POST]', err);
    return NextResponse.json({ ok: false, error: dbErrorText(err) }, { status: 500 });
  }
}
