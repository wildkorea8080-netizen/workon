import { NextRequest, NextResponse } from 'next/server';
import { getSuperAdminFromRequest } from '@/lib/super-auth';
import { KEY_VERIFY_TIMEOUT_MS, anthropicKeyVerdict, parseVerifyRequest } from '@/lib/api-key-verify';

export const dynamic = 'force-dynamic';

export async function POST(request: NextRequest, { params: _ }: { params: { id: string } }) {
  if (!getSuperAdminFromRequest(request))
    return NextResponse.json({ ok: false, error: '인증 필요' }, { status: 401 });

  // 깨진 요청·가린 키는 400(2026-11-19 — 예전엔 깨진 몸이 500)
  const parsed = parseVerifyRequest(await request.json().catch(() => null));
  if (!parsed.ok || parsed.value.stored) {
    return NextResponse.json({ ok: false, error: parsed.ok ? '확인할 키를 넣어 주세요.' : parsed.message }, { status: 400 });
  }

  let status: number | null = null;
  try {
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'x-api-key': parsed.value.key as string,
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 5,
        messages: [{ role: 'user', content: 'ping' }],
      }),
      signal: AbortSignal.timeout(KEY_VERIFY_TIMEOUT_MS),
    });
    status = res.status;
  } catch {
    status = null; // 연결 실패·시간 초과 — 확인 못 함(예전엔 500)
  }
  const verdict = anthropicKeyVerdict(status);
  return NextResponse.json({ ok: true, valid: verdict.valid, message: verdict.message, status });
}
