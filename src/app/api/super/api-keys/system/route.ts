import { NextRequest, NextResponse } from 'next/server';
import { getSuperAdminFromRequest } from '@/lib/super-auth';
import { supabaseAdmin } from '@/lib/supabaseAdmin';
import { encryptApiKey, decryptApiKey, maskApiKey } from '@/lib/crypto';
import { logSystem } from '@/lib/logger';

export const dynamic = 'force-dynamic';

const PROVIDERS = ['anthropic', 'voyage'] as const;

// GET: 시스템 기본 키 조회
export async function GET(request: NextRequest) {
  if (!getSuperAdminFromRequest(request))
    return NextResponse.json({ ok: false, error: '인증 필요' }, { status: 401 });

  const { data: keys } = await supabaseAdmin
    .from('api_keys')
    .select('id, provider, key_prefix, key_value, is_active, updated_at')
    .is('organization_id', null)
    .eq('is_active', true);

  const result: Record<string, any> = {};
  for (const p of PROVIDERS) {
    const k = (keys ?? []).find((r: { provider: string }) => r.provider === p);
    result[p] = k
      ? { id: k.id, masked: k.key_value ? maskApiKey(decryptApiKey(k.key_value)) : '(미설정)', updatedAt: k.updated_at, hasKey: !!k.key_value }
      : { id: null, masked: '(미설정)', updatedAt: null, hasKey: false };
  }

  // 시스템 키를 사용 중인 기관 수 (자체 키 없는 기관)
  const { count: orgTotal } = await supabaseAdmin
    .from('organizations').select('id', { count: 'exact', head: true }).eq('status', 'active');

  // 이번달 시스템 키 사용 토큰 (org_id가 없는 usage_logs)
  const monthStart = new Date(new Date().getFullYear(), new Date().getMonth(), 1).toISOString();
  const { data: usage } = await supabaseAdmin
    .from('usage_logs')
    .select('details')
    .is('organization_id', null)
    .gte('created_at', monthStart);

  const totalTokens = (usage ?? []).reduce((s: number, r: any) =>
    s + ((r.details?.input_tokens ?? 0) + (r.details?.output_tokens ?? 0)), 0);

  return NextResponse.json({
    ok: true,
    data: {
      keys: result,
      stats: {
        systemKeyOrgCount: orgTotal ?? 0,
        totalTokensThisMonth: totalTokens,
        estimatedCostUsd: parseFloat(((totalTokens / 1_000_000) * 9).toFixed(4)),
      },
    },
  });
}

// PATCH: 시스템 키 저장
export async function PATCH(request: NextRequest) {
  if (!getSuperAdminFromRequest(request))
    return NextResponse.json({ ok: false, error: '인증 필요' }, { status: 401 });

  const { provider, keyValue } = await request.json();
  if (!provider || !keyValue)
    return NextResponse.json({ ok: false, error: 'provider, keyValue 필수' }, { status: 400 });

  const encrypted = encryptApiKey(keyValue);
  const prefix    = keyValue.slice(0, 10);

  // 기존 시스템 키 비활성화
  await supabaseAdmin.from('api_keys')
    .update({ is_active: false })
    .is('organization_id', null)
    .eq('provider', provider);

  // 신규 삽입
  const { error } = await supabaseAdmin.from('api_keys').insert({
    organization_id: null,
    provider,
    key_prefix: prefix,
    key_value: encrypted,
    is_active: true,
    is_default: true,
    label: `시스템 기본 키 - ${provider}`,
  });

  if (error) return NextResponse.json({ ok: false, error: error.message }, { status: 500 });
  logSystem({ level: 'warning', category: 'security',
    message: `시스템 API 키 변경: ${provider}`,
    details: { provider, prefix } });
  return NextResponse.json({ ok: true });
}
