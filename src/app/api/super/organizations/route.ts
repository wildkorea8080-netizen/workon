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
import { parseOrgCreateInput } from '@/lib/org-create-input';
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
  // 숫자가 아니면 기본값(2026-11-19 — 예전엔 NaN이 범위로 가 오류였다)
  const page   = Math.max(1, Number.parseInt(searchParams.get('page')  ?? '1', 10) || 1);
  const limit  = Math.min(100, Math.max(1, Number.parseInt(searchParams.get('limit') ?? '20', 10) || 20));

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

      const { data, count, error: fallbackError } = await q
        .order('created_at', { ascending: false })
        .range((page - 1) * limit, page * limit - 1);
      // 예비 길도 못 읽으면 빈 목록이 아니라 오류(2026-11-19 — 예전엔 '기관 없음'으로 보였다)
      if (fallbackError) throw fallbackError;

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
    // 입력은 아무것도 만들기 전에 본다(2026-11-19, `org-create-input.ts`) — 예전엔 틀린 날짜가 기관을 만든 뒤 던져 반쪽 기관이 남았다
    const parsed = parseOrgCreateInput(await request.json().catch(() => null));
    if (!parsed.ok) return NextResponse.json({ ok: false, error: parsed.message }, { status: 400 });
    const {
      name, type, plan,
      contractStart, contractEnd,
      maxUsers, maxAgents, maxTokensPerMonth,
      adminEmail,
      monthlyFee, notes,
    } = parsed.value;
    // slug 형식 — 기관 관리자 '기관 정보'와 같은 규칙(2026-11-17, `org-slug.ts`)
    const orgSlug = parsed.value.slug;

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
        name,
        slug: orgSlug,
        type,
        status: 'active',
        plan,
        max_users: maxUsers,
        max_agents: maxAgents,
        monthly_token_limit: maxTokensPerMonth,
        notes,
      })
      .select()
      .single();

    if (orgError || !org) throw orgError ?? new Error('기관 생성 실패');

    // 2) contracts INSERT
    const { error: contractError } = await supabaseAdmin
      .from('contracts')
      .insert({
        organization_id: org.id,
        plan,
        status: 'active',
        started_at: contractStart ? new Date(contractStart).toISOString() : new Date().toISOString(),
        expires_at: contractEnd   ? new Date(contractEnd).toISOString()   : null,
        max_users: maxUsers,
        max_agents: maxAgents,
        monthly_token_limit: maxTokensPerMonth,
        price_per_month: monthlyFee,
        created_by: admin.sub,
      });

    // 계약을 못 넣으면 알린다(2026-11-19 — 예전엔 `console.warn` 한 줄뿐이라 계약 없는 기관이 '등록됨'으로 보였다)
    const warnings: string[] = [];
    if (contractError) warnings.push(await reportContractSync('org_contract_create', org.id, contractError.code ?? 'error'));

    // 3) 관리자 초대 토큰 생성 (invitations INSERT)
    //    먼저 기관에 기본 부서 생성
    // 못 만들면 기본 비서·관리자 초대가 빠진다 — 예전엔 소속 없는 초대를 만들어(가입에서 거절됨) 동작하지 않는 링크를 돌려줬다(2026-11-17)
    const { data: dept, error: deptError } = await supabaseAdmin
      .from('departments')
      .insert({
        name: `${name} 본청`,
        slug: `${orgSlug}-main`,
        description: `${name} 기본 부서`,
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
    let inviteUrl: string | null = null;
    if (!dept?.id) {
      warnings.push(await reportContractSync('org_default_department', org.id, deptError?.code ?? 'no_row'));
    } else {
      const { error: inviteErr } = await supabaseAdmin.from('invitations').insert({
        email: adminEmail,
        department_id: dept.id,
        role: 'ADMIN',
        token: inviteToken,
        invited_by: admin.sub,
        expires_at: new Date(Date.now() + 7 * 86400000).toISOString(),
      });
      if (inviteErr) warnings.push(await reportContractSync('org_admin_invitation', org.id, inviteErr.code ?? 'error'));
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
      ...(warnings.length ? { warning: warnings.join(' ') } : {}),
    });
  } catch (err: any) {
    console.error('[super/organizations POST]', err);
    return NextResponse.json({ ok: false, error: dbErrorText(err) }, { status: 500 });
  }
}
