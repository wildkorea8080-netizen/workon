import { NextRequest, NextResponse } from 'next/server';
import { getSuperAdminFromRequest } from '@/lib/super-auth';
import { supabaseAdmin } from '@/lib/supabaseAdmin';

export const dynamic = 'force-dynamic';

export async function PATCH(
  request: NextRequest,
  { params }: { params: { id: string } }
) {
  const admin = getSuperAdminFromRequest(request);
  if (!admin) return NextResponse.json({ ok: false, error: '인증 필요' }, { status: 401 });

  try {
    const { status, plan, notes } = await request.json();
    const { id } = params;

    const { data: before } = await supabaseAdmin
      .from('organizations')
      .select('id, name, status, plan')
      .eq('id', id)
      .single();

    if (!before) {
      return NextResponse.json({ ok: false, error: '기관을 찾을 수 없습니다.' }, { status: 404 });
    }

    const updateData: Record<string, unknown> = { updated_at: new Date().toISOString() };
    if (status !== undefined) updateData.status = status;
    if (plan    !== undefined) updateData.plan   = plan;
    if (notes   !== undefined) updateData.notes  = notes;

    const { data: updated, error } = await supabaseAdmin
      .from('organizations')
      .update(updateData)
      .eq('id', id)
      .select()
      .single();

    if (error) throw error;

    // 정지 시 contracts도 suspended로
    if (status === 'suspended') {
      await supabaseAdmin
        .from('contracts')
        .update({ status: 'cancelled' })
        .eq('organization_id', id)
        .eq('status', 'active');
    }
    if (status === 'active') {
      await supabaseAdmin
        .from('contracts')
        .update({ status: 'active' })
        .eq('organization_id', id)
        .eq('status', 'cancelled');
    }

    // 감사 로그
    await supabaseAdmin.from('super_admin_logs').insert({
      admin_user_id: admin.sub,
      action: status === 'suspended' ? 'org_suspended' : 'org_updated',
      target_type: 'organization',
      target_id: id,
      before_data: before,
      after_data: updateData,
    });

    return NextResponse.json({ ok: true, data: updated });
  } catch (err: any) {
    console.error('[super/organizations PATCH]', err);
    return NextResponse.json({ ok: false, error: err.message }, { status: 500 });
  }
}

export async function GET(
  request: NextRequest,
  { params }: { params: { id: string } }
) {
  const admin = getSuperAdminFromRequest(request);
  if (!admin) return NextResponse.json({ ok: false, error: '인증 필요' }, { status: 401 });

  try {
    const { data: org, error } = await supabaseAdmin
      .from('organizations')
      .select(`
        *,
        departments (id, name, slug),
        contracts (id, plan, status, started_at, expires_at, price_per_month, max_users, max_agents)
      `)
      .eq('id', params.id)
      .single();

    if (error || !org) {
      return NextResponse.json({ ok: false, error: '기관을 찾을 수 없습니다.' }, { status: 404 });
    }

    // 사용자 수
    const { count: userCount } = await supabaseAdmin
      .from('users')
      .select('id', { count: 'exact', head: true })
      .in('department_id', (org.departments ?? []).map((d: any) => d.id));

    // 이번달 토큰
    const { data: usageLogs } = await supabaseAdmin
      .from('usage_logs')
      .select('details')
      .eq('organization_id', params.id)
      .eq('action', 'chat_message')
      .gte('created_at', new Date(new Date().getFullYear(), new Date().getMonth(), 1).toISOString());

    const tokensThisMonth = (usageLogs ?? []).reduce((sum: number, l: any) => {
      return sum + ((l.details?.input_tokens ?? 0) + (l.details?.output_tokens ?? 0));
    }, 0);

    return NextResponse.json({
      ok: true,
      data: { ...org, user_count: userCount ?? 0, tokens_this_month: tokensThisMonth },
    });
  } catch (err: any) {
    console.error('[super/organizations/:id GET]', err);
    return NextResponse.json({ ok: false, error: err.message }, { status: 500 });
  }
}
