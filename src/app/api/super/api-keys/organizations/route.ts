import { NextRequest, NextResponse } from 'next/server';
import { getSuperAdminFromRequest } from '@/lib/super-auth';
import { supabaseAdmin } from '@/lib/supabaseAdmin';
import { maskApiKey } from '@/lib/crypto';

export const dynamic = 'force-dynamic';

export async function GET(request: NextRequest) {
  if (!getSuperAdminFromRequest(request))
    return NextResponse.json({ ok: false, error: '인증 필요' }, { status: 401 });

  const [{ data: orgs }, { data: allKeys }] = await Promise.all([
    supabaseAdmin.from('organizations').select('id, name, status').order('created_at'),
    supabaseAdmin.from('api_keys')
      .select('organization_id, provider, key_prefix, updated_at')
      .not('organization_id', 'is', null)
      .eq('is_active', true),
  ]);

  const monthStart = new Date(new Date().getFullYear(), new Date().getMonth(), 1).toISOString();
  const { data: usageLogs } = await supabaseAdmin
    .from('usage_logs')
    .select('organization_id')
    .not('organization_id', 'is', null)
    .eq('action', 'chat_message')
    .gte('created_at', monthStart);

  const usageCountMap = new Map<string, number>();
  for (const l of usageLogs ?? []) {
    usageCountMap.set(l.organization_id, (usageCountMap.get(l.organization_id) ?? 0) + 1);
  }

  const result = (orgs ?? []).map((org: { id: string; [k: string]: any }) => {
    const anthropicKey = (allKeys ?? []).find((k: { organization_id: string; provider: string; updated_at?: string }) => k.organization_id === org.id && k.provider === 'anthropic');
    const voyageKey    = (allKeys ?? []).find((k: { organization_id: string; provider: string; updated_at?: string }) => k.organization_id === org.id && k.provider === 'voyage');
    const hasOwnKey    = !!(anthropicKey || voyageKey);
    const lastUpdated  = [anthropicKey?.updated_at, voyageKey?.updated_at]
      .filter(Boolean).sort().reverse()[0] ?? null;

    return {
      id: org.id,
      name: org.name,
      status: org.status,
      hasOwnKey,
      anthropicMasked: anthropicKey?.key_prefix ? anthropicKey.key_prefix + '••••' : null,
      voyageMasked:    voyageKey?.key_prefix    ? voyageKey.key_prefix    + '••••' : null,
      lastUpdated,
      callsThisMonth: usageCountMap.get(org.id) ?? 0,
    };
  });

  return NextResponse.json({ ok: true, data: result });
}
