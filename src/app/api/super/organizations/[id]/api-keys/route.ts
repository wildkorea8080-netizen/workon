import { NextRequest, NextResponse } from 'next/server';
import { getSuperAdminFromRequest } from '@/lib/super-auth';
import { supabaseAdmin } from '@/lib/supabaseAdmin';
import { encryptApiKey, decryptApiKey, maskKey } from '@/lib/crypto';
import { UNSUPPORTED_PROVIDER_MESSAGE, isApiKeyProvider } from '@/lib/api-key-providers';
import { writeAuditRow } from '@/lib/audit-write';

const KEY_SAVE_FAILED = 'API 키를 저장하지 못했습니다. 잠시 뒤 다시 시도해 주세요.';

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

  return NextResponse.json({
    ok: true,
    data: {
      useSystemDefault: !anthropic,
      anthropic: anthropic ? {
        id: anthropic.id,
        prefix: anthropic.key_prefix ?? '',
        masked: anthropic.key_value ? maskKey(decryptApiKey(anthropic.key_value)) : '',
        hasKey: !!anthropic.key_value,
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
    const { error } = await supabaseAdmin
      .from('api_keys')
      .update({ is_active: false })
      .eq('organization_id', params.id);
    // Supabase는 실패를 던지지 않고 돌려준다 — 예전엔 실패해도 성공으로 답했다(2026-11-17)
    if (error) return NextResponse.json({ ok: false, error: KEY_SAVE_FAILED }, { status: 500 });
    await writeAuditRow('super_admin_logs', {
      admin_user_id: admin.sub,
      action: 'api_key_changed',
      target_type: 'organization',
      target_id: params.id,
      after_data: { scope: 'organization', use_system_default: true },
    }, 'api_key_changed');
    return NextResponse.json({ ok: true });
  }

  if (!provider || !keyValue) {
    return NextResponse.json({ ok: false, error: 'provider와 keyValue 필수' }, { status: 400 });
  }
  if (!isApiKeyProvider(provider)) {
    return NextResponse.json({ ok: false, error: UNSUPPORTED_PROVIDER_MESSAGE }, { status: 400 });
  }

  const encrypted = encryptApiKey(keyValue);
  const prefix = keyValue.slice(0, 8);

  // upsert (기존 키 비활성화 후 새로 삽입)
  const off = await supabaseAdmin
    .from('api_keys')
    .update({ is_active: false })
    .eq('organization_id', params.id)
    .eq('provider', provider);
  if (off.error) return NextResponse.json({ ok: false, error: KEY_SAVE_FAILED }, { status: 500 });

  const added = await supabaseAdmin.from('api_keys').insert({
    organization_id: params.id,
    provider,
    key_prefix: prefix,
    key_value: encrypted,
    is_active: true,
    is_default: true,
    created_by: admin.sub,
  });
  if (added.error) return NextResponse.json({ ok: false, error: KEY_SAVE_FAILED }, { status: 500 });

  // 조작 기록(2026-11-17) — 키 값·앞부분은 남기지 않는다
  await writeAuditRow('super_admin_logs', {
    admin_user_id: admin.sub,
    action: 'api_key_changed',
    target_type: 'organization',
    target_id: params.id,
    after_data: { scope: 'organization', provider },
  }, 'api_key_changed');
  return NextResponse.json({ ok: true });
}
