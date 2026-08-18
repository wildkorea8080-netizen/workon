import { NextRequest, NextResponse } from 'next/server';
import { getSuperAdminFromRequest } from '@/lib/super-auth';
import { supabaseAdmin } from '@/lib/supabaseAdmin';
import { encryptApiKey, decryptApiKey, maskKey } from '@/lib/crypto';

export const dynamic = 'force-dynamic';

export async function GET(request: NextRequest, { params }: { params: { id: string } }) {
  if (!getSuperAdminFromRequest(request))
    return NextResponse.json({ ok: false, error: '인증 필요' }, { status: 401 });

  const { data: keys } = await supabaseAdmin
    .from('api_keys')
    .select('id, provider, key_prefix, key_value, is_active, is_default, label')
    .eq('organization_id', params.id)
    .eq('is_active', true);

  const anthropic = (keys ?? []).find((k: { provider: string; [x: string]: any }) => k.provider === 'anthropic');
  const voyage    = (keys ?? []).find((k: { provider: string; [x: string]: any }) => k.provider === 'voyage');

  return NextResponse.json({
    ok: true,
    data: {
      useSystemDefault: !anthropic && !voyage,
      anthropic: anthropic ? {
        id: anthropic.id,
        prefix: anthropic.key_prefix ?? '',
        masked: anthropic.key_value ? maskKey(decryptApiKey(anthropic.key_value)) : '',
        hasKey: !!anthropic.key_value,
      } : null,
      voyage: voyage ? {
        id: voyage.id,
        prefix: voyage.key_prefix ?? '',
        masked: voyage.key_value ? maskKey(decryptApiKey(voyage.key_value)) : '',
        hasKey: !!voyage.key_value,
      } : null,
    },
  });
}

export async function PATCH(request: NextRequest, { params }: { params: { id: string } }) {
  const admin = getSuperAdminFromRequest(request);
  if (!admin) return NextResponse.json({ ok: false, error: '인증 필요' }, { status: 401 });

  const { provider, keyValue, useSystemDefault } = await request.json();

  // useSystemDefault ON → 기존 키 비활성화
  if (useSystemDefault === true) {
    await supabaseAdmin
      .from('api_keys')
      .update({ is_active: false })
      .eq('organization_id', params.id);
    return NextResponse.json({ ok: true });
  }

  if (!provider || !keyValue) {
    return NextResponse.json({ ok: false, error: 'provider와 keyValue 필수' }, { status: 400 });
  }

  const encrypted = encryptApiKey(keyValue);
  const prefix = keyValue.slice(0, 8);

  // upsert (기존 키 비활성화 후 새로 삽입)
  await supabaseAdmin
    .from('api_keys')
    .update({ is_active: false })
    .eq('organization_id', params.id)
    .eq('provider', provider);

  await supabaseAdmin.from('api_keys').insert({
    organization_id: params.id,
    provider,
    key_prefix: prefix,
    key_value: encrypted,
    is_active: true,
    is_default: true,
    created_by: admin.sub,
  });

  return NextResponse.json({ ok: true });
}
