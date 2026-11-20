import { NextRequest, NextResponse } from 'next/server';
import { getSuperAdminFromRequest } from '@/lib/super-auth';
import { supabaseAdmin } from '@/lib/supabaseAdmin';
import { pagedRows } from '@/lib/paged-select';
import { maskApiKey } from '@/lib/crypto';
import { kstMonthStart } from '@/lib/kst-time';

export const dynamic = 'force-dynamic';

export async function GET(request: NextRequest) {
  if (!getSuperAdminFromRequest(request))
    return NextResponse.json({ ok: false, error: '인증 필요' }, { status: 401 });

  const [{ data: orgs, error: orgsError }, { data: allKeys, error: keysError }] = await Promise.all([
    supabaseAdmin.from('organizations').select('id, name, status').order('created_at'),
    supabaseAdmin.from('api_keys')
      .select('organization_id, provider, key_prefix, updated_at')
      .not('organization_id', 'is', null)
      .eq('is_active', true),
  ]);

  // 못 읽으면 '키 없음'·'호출 0'으로 보이지 않는다(2026-11-19)
  if (orgsError || keysError) {
    return NextResponse.json({ ok: false, error: '기관별 키 현황을 읽지 못했습니다. 잠시 뒤 다시 시도해 주세요.' }, { status: 503 });
  }

  const monthStart = kstMonthStart().toISOString();
  const { data: usageLogs, error: usageError } = await pagedRows<{ organization_id: string }>((a, b, w) => supabaseAdmin
    .from('usage_logs')
    .select('organization_id', w ? { count: 'exact' } : undefined)
    .not('organization_id', 'is', null)
    .eq('action', 'chat_message')
    .gte('created_at', monthStart)
    .order('id').range(a, b));

  if (usageError) {
    return NextResponse.json({ ok: false, error: '이번 달 호출 수를 읽지 못했습니다. 잠시 뒤 다시 시도해 주세요.' }, { status: 503 });
  }

  const usageCountMap = new Map<string, number>();
  for (const l of usageLogs ?? []) {
    usageCountMap.set(l.organization_id, (usageCountMap.get(l.organization_id) ?? 0) + 1);
  }

  const result = (orgs ?? []).map((org: { id: string; [k: string]: any }) => {
    const anthropicKey = (allKeys ?? []).find((k: { organization_id: string; provider: string; updated_at?: string }) => k.organization_id === org.id && k.provider === 'anthropic');
    // 옛 Voyage 키는 보지 않는다(api-key-providers.ts — 쓰지 않는 업체)
    const hasOwnKey    = !!anthropicKey;
    const lastUpdated  = anthropicKey?.updated_at ?? null;

    return {
      id: org.id,
      name: org.name,
      status: org.status,
      hasOwnKey,
      anthropicMasked: anthropicKey?.key_prefix ? anthropicKey.key_prefix + '••••' : null,
      lastUpdated,
      callsThisMonth: usageCountMap.get(org.id) ?? 0,
    };
  });

  return NextResponse.json({ ok: true, data: result });
}
