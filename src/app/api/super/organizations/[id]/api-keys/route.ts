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

  // 못 읽으면 '키 없음(시스템 키)'으로 보이지 않는다(2026-11-19)
  const { data: keys, error: keysError } = await supabaseAdmin
    .from('api_keys')
    .select('id, provider, key_prefix, key_value, is_active, is_default, label')
    .eq('organization_id', params.id)
    .eq('is_active', true);
  if (keysError) return NextResponse.json({ ok: false, error: 'API 키 상태를 읽지 못했습니다. 잠시 뒤 다시 시도해 주세요.' }, { status: 503 });

  const anthropic = (keys ?? []).find((k: { provider: string; [x: string]: any }) => k.provider === 'anthropic');
  // 풀지 못하는 암호문(키를 바꾼 뒤 등)이어도 화면은 열린다
  const masked = (v: string) => { try { return maskKey(decryptApiKey(v)); } catch { return '(풀지 못함)'; } };

  return NextResponse.json({
    ok: true,
    data: {
      useSystemDefault: !anthropic,
      anthropic: anthropic ? {
        id: anthropic.id,
        prefix: anthropic.key_prefix ?? '',
        masked: anthropic.key_value ? masked(anthropic.key_value) : '',
        hasKey: !!anthropic.key_value,
      } : null,
    },
  });
}

export async function PATCH(request: NextRequest, { params }: { params: { id: string } }) {
  const admin = getSuperAdminFromRequest(request);
  if (!admin) return NextResponse.json({ ok: false, error: '인증 필요' }, { status: 401 });

  const body = await request.json().catch(() => null) as { provider?: unknown; keyValue?: unknown; useSystemDefault?: unknown } | null;
  if (!body || typeof body !== 'object') return NextResponse.json({ ok: false, error: '요청 형식이 올바르지 않습니다.' }, { status: 400 });
  const { provider, useSystemDefault } = body;
  // 키는 앞뒤 공백을 떼고 글자로만(2026-11-19 — 숫자 등이 오면 slice에서 500이었다)
  const keyValue = typeof body.keyValue === 'string' ? body.keyValue.trim() : '';

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

  if (!provider || !keyValue || keyValue.length > 500) {
    return NextResponse.json({ ok: false, error: 'provider와 keyValue 필수' }, { status: 400 });
  }
  if (!isApiKeyProvider(provider)) {
    return NextResponse.json({ ok: false, error: UNSUPPORTED_PROVIDER_MESSAGE }, { status: 400 });
  }

  // 운영에서 암호화 키가 없으면 거절한다(고정 값으로 저장하지 않음, 2026-11-17)
  let encrypted: string;
  try { encrypted = encryptApiKey(keyValue); } catch { return NextResponse.json({ ok: false, error: '암호화 키가 설정되지 않아 저장할 수 없습니다 — 운영자에게 알려 주세요.' }, { status: 503 }); }
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
