import { NextRequest, NextResponse } from 'next/server';
import { BAD_BODY_MESSAGE, readJsonObject } from '@/lib/request-body';
import { getSuperAdminFromRequest } from '@/lib/super-auth';
import { supabaseAdmin } from '@/lib/supabaseAdmin';
import { pagedRows } from '@/lib/paged-select';
import { chatTokensOf } from '@/lib/org-chat-tokens';
import { encryptApiKey, decryptApiKey, maskApiKey } from '@/lib/crypto';
import { logSystem } from '@/lib/logger';
import { estimateCostUsd } from '@/lib/models';
import { kstMonthStart } from '@/lib/kst-time';
import { API_KEY_PROVIDERS, UNSUPPORTED_PROVIDER_MESSAGE, isApiKeyProvider } from '@/lib/api-key-providers';
import { writeAuditRow } from '@/lib/audit-write';

export const dynamic = 'force-dynamic';

const PROVIDERS = API_KEY_PROVIDERS;

// GET: 시스템 기본 키 조회
export async function GET(request: NextRequest) {
  if (!getSuperAdminFromRequest(request))
    return NextResponse.json({ ok: false, error: '인증 필요' }, { status: 401 });

  // 못 읽으면 '(미설정)'으로 보이지 않는다(2026-11-19)
  const { data: keys, error: keysError } = await supabaseAdmin
    .from('api_keys')
    .select('id, provider, key_prefix, key_value, is_active, updated_at')
    .is('organization_id', null)
    .eq('is_active', true);
  if (keysError) return NextResponse.json({ ok: false, error: 'API 키 상태를 읽지 못했습니다. 잠시 뒤 다시 시도해 주세요.' }, { status: 503 });
  const masked = (v: string) => { try { return maskApiKey(decryptApiKey(v)); } catch { return '(풀지 못함)'; } };

  const result: Record<string, any> = {};
  for (const p of PROVIDERS) {
    const k = (keys ?? []).find((r: { provider: string }) => r.provider === p);
    result[p] = k
      ? { id: k.id, masked: k.key_value ? masked(k.key_value) : '(미설정)', updatedAt: k.updated_at, hasKey: !!k.key_value }
      : { id: null, masked: '(미설정)', updatedAt: null, hasKey: false };
  }

  // 시스템 키를 사용 중인 기관 수 (자체 키 없는 기관)
  const { count: orgTotal, error: orgError } = await supabaseAdmin
    .from('organizations').select('id', { count: 'exact', head: true }).eq('status', 'active');

  // 이번달 시스템 키 사용 토큰 (org_id가 없는 usage_logs)
  const monthStart = kstMonthStart().toISOString();
  const { data: usage, error: usageError } = await pagedRows<{ details: any }>((a, b, w) => supabaseAdmin
    .from('usage_logs')
    .select('details', w ? { count: 'exact' } : undefined)
    .is('organization_id', null)
    .gte('created_at', monthStart)
    .order('id').range(a, b));

  // 못 읽으면 null(2026-11-20 — 예전엔 0개·0토큰), 숫자만 더한다(예전엔 글 값이 이어 붙었다)
  const totalTokens = usageError ? null : (usage ?? []).reduce((s: number, r: { details: unknown }) => s + chatTokensOf(r.details), 0);

  return NextResponse.json({
    ok: true,
    data: {
      keys: result,
      stats: {
        systemKeyOrgCount: orgError ? null : orgTotal ?? 0,
        totalTokensThisMonth: totalTokens,
        // 입출력 비율을 알 수 없어 절반씩으로 가정한 개략 추정치
        estimatedCostUsd: totalTokens === null ? null : estimateCostUsd({ input_tokens: totalTokens / 2, output_tokens: totalTokens / 2 }),
      },
    },
  });
}

// PATCH: 시스템 키 저장
export async function PATCH(request: NextRequest) {
  const admin = getSuperAdminFromRequest(request);
  if (!admin)
    return NextResponse.json({ ok: false, error: '인증 필요' }, { status: 401 });

  const body = await readJsonObject(request);
  if (!body) return NextResponse.json({ ok: false, error: BAD_BODY_MESSAGE }, { status: 400 });
  const { provider, keyValue } = body;
  if (!provider || !keyValue)
    return NextResponse.json({ ok: false, error: 'provider, keyValue 필수' }, { status: 400 });
  if (!isApiKeyProvider(provider))
    return NextResponse.json({ ok: false, error: UNSUPPORTED_PROVIDER_MESSAGE }, { status: 400 });

  // 운영에서 암호화 키가 없으면 거절한다(고정 값으로 저장하지 않음, 2026-11-17)
  let encrypted: string;
  try { encrypted = encryptApiKey(keyValue); } catch { return NextResponse.json({ ok: false, error: '암호화 키가 설정되지 않아 저장할 수 없습니다 — 운영자에게 알려 주세요.' }, { status: 503 }); }
  const prefix    = keyValue.slice(0, 10);

  // 기존 시스템 키 비활성화
  // 못 끄고 새 키를 넣으면 시스템 키가 둘 다 켜진다 — 넣지 않는다(2026-11-17)
  const off = await supabaseAdmin.from('api_keys')
    .update({ is_active: false })
    .is('organization_id', null)
    .eq('provider', provider);
  if (off.error) return NextResponse.json({ ok: false, error: 'API 키를 저장하지 못했습니다. 잠시 뒤 다시 시도해 주세요.' }, { status: 500 });

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

  if (error) return NextResponse.json({ ok: false, error: 'API 키를 저장하지 못했습니다. 잠시 뒤 다시 시도해 주세요.' }, { status: 500 });
  logSystem({ level: 'warning', category: 'security',
    message: `시스템 API 키 변경: ${provider}`,
    details: { provider, prefix } });
  // 조작 기록(2026-11-17) — 키 값·앞부분은 남기지 않는다
  await writeAuditRow('super_admin_logs', {
    admin_user_id: admin.sub,
    action: 'api_key_changed',
    target_type: 'api_key',
    target_id: null,
    after_data: { scope: 'system', provider },
  }, 'api_key_changed');
  return NextResponse.json({ ok: true });
}
