import { NextRequest, NextResponse } from 'next/server';
import { getSuperAdminFromRequest } from '@/lib/super-auth';
import { supabaseAdmin } from '@/lib/supabaseAdmin';
import { decryptApiKey } from '@/lib/crypto';
import { KEY_VERIFY_TIMEOUT_MS, anthropicKeyVerdict, parseVerifyRequest } from '@/lib/api-key-verify';

export const dynamic = 'force-dynamic';

export async function POST(request: NextRequest) {
  if (!getSuperAdminFromRequest(request))
    return NextResponse.json({ ok: false, error: '인증 필요' }, { status: 401 });

  const parsed = parseVerifyRequest(await request.json().catch(() => null));
  if (!parsed.ok) return NextResponse.json({ ok: false, error: parsed.message }, { status: 400 });

  // 저장한 시스템 키는 서버가 풀어 확인한다(2026-11-19 — 예전엔 화면이 가린 키를 보내 늘 '틀림')
  let key = parsed.value.key;
  if (parsed.value.stored) {
    const { data: row, error } = await supabaseAdmin
      .from('api_keys').select('key_value')
      .is('organization_id', null).eq('provider', 'anthropic').eq('is_active', true)
      .order('updated_at', { ascending: false }).limit(1).maybeSingle();
    if (error) return NextResponse.json({ ok: false, error: '저장한 키를 읽지 못했습니다. 잠시 뒤 다시 시도해 주세요.' }, { status: 503 });
    if (!row?.key_value) return NextResponse.json({ ok: false, error: '저장한 키가 없습니다.' }, { status: 404 });
    try { key = decryptApiKey(row.key_value); }
    catch { return NextResponse.json({ ok: false, error: '저장한 키를 풀지 못했습니다(암호화 키가 바뀌었을 수 있습니다). 새 키로 바꿔 주세요.' }, { status: 500 }); }
  }

  let status: number | null = null;
  let model: string | null = null;
  try {
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'x-api-key': key as string,
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 10,
        messages: [{ role: 'user', content: 'ping' }],
      }),
      signal: AbortSignal.timeout(KEY_VERIFY_TIMEOUT_MS),
    });
    status = res.status;
    const body = await res.json().catch(() => null);
    model = typeof body?.model === 'string' ? body.model : null;
  } catch {
    status = null; // 연결 실패·시간 초과 — 확인 못 함
  }
  const verdict = anthropicKeyVerdict(status);
  // Anthropic 원문은 싣지 않는다
  return NextResponse.json({ ok: true, valid: verdict.valid, message: verdict.message, model: verdict.valid ? model : null });
}
