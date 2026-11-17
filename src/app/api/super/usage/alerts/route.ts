import { NextRequest, NextResponse } from 'next/server';
import { getSuperAdminFromRequest } from '@/lib/super-auth';
import { supabaseAdmin } from '@/lib/supabaseAdmin';
import { loadChatTokensByOrg } from '@/lib/org-chat-tokens';
import { kstMonthStart } from '@/lib/kst-time';

export const dynamic = 'force-dynamic';

export async function GET(request: NextRequest) {
  if (!getSuperAdminFromRequest(request))
    return NextResponse.json({ ok: false, error: '인증 필요' }, { status: 401 });

  const monthStart = kstMonthStart().toISOString();

  const [{ data: orgs, error: orgErr }, usage] = await Promise.all([
    supabaseAdmin.from('organizations')
      .select('id, name, monthly_token_limit').eq('status', 'active'),
    // 한도 판정과 같은 셈(2026-11-17, `org-chat-tokens.ts`)
    loadChatTokensByOrg(monthStart),
  ]);
  // 못 읽었으면 '경보 없음'으로 꾸미지 않는다
  if (orgErr || !usage) return NextResponse.json({ ok: false, error: '사용량을 불러오지 못했습니다. 잠시 뒤 다시 시도해 주세요.' }, { status: 503 });
  const usageMap = usage;

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
