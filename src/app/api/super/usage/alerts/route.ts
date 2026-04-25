import { NextRequest, NextResponse } from 'next/server';
import { getSuperAdminFromRequest } from '@/lib/super-auth';
import { supabaseAdmin } from '@/lib/supabaseAdmin';

export const dynamic = 'force-dynamic';

export async function GET(request: NextRequest) {
  if (!getSuperAdminFromRequest(request))
    return NextResponse.json({ ok: false, error: '인증 필요' }, { status: 401 });

  const monthStart = new Date(new Date().getFullYear(), new Date().getMonth(), 1).toISOString();

  const [{ data: orgs }, { data: logs }] = await Promise.all([
    supabaseAdmin.from('organizations')
      .select('id, name, monthly_token_limit').eq('status', 'active'),
    supabaseAdmin.from('usage_logs')
      .select('organization_id, details')
      .eq('action', 'chat_message')
      .gte('created_at', monthStart),
  ]);

  const usageMap = new Map<string, number>();
  for (const l of logs ?? []) {
    const oid = l.organization_id;
    if (!oid) continue;
    const t = (l.details?.input_tokens ?? 0) + (l.details?.output_tokens ?? 0);
    usageMap.set(oid, (usageMap.get(oid) ?? 0) + t);
  }

  const warning: any[] = [];
  const exceeded: any[] = [];

  for (const org of orgs ?? []) {
    const limit = org.monthly_token_limit ?? 0;
    if (!limit) continue;
    const used = usageMap.get(org.id) ?? 0;
    const pct  = Math.round((used / limit) * 100);
    const base = { orgId: org.id, orgName: org.name, usagePercent: pct, usedTokens: used, limit };
    if (pct >= 100) exceeded.push({ ...base, excessTokens: used - limit });
    else if (pct >= 80) warning.push({ ...base, tokensLeft: limit - used });
  }

  warning.sort((a, b) => b.usagePercent - a.usagePercent);
  exceeded.sort((a, b) => b.usagePercent - a.usagePercent);

  return NextResponse.json({ ok: true, data: { warning, exceeded } });
}
