import { NextRequest, NextResponse } from 'next/server';
import { getSuperAdminFromRequest } from '@/lib/super-auth';

export const dynamic = 'force-dynamic';

export async function POST(request: NextRequest, { params: _ }: { params: { id: string } }) {
  if (!getSuperAdminFromRequest(request))
    return NextResponse.json({ ok: false, error: '인증 필요' }, { status: 401 });

  const { keyType, key } = await request.json();
  if (!keyType || !key) return NextResponse.json({ ok: false, error: 'keyType, key 필수' }, { status: 400 });

  try {
    if (keyType === 'anthropic') {
      const res = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'x-api-key': key,
          'anthropic-version': '2023-06-01',
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          model: 'claude-haiku-4-5-20251001',
          max_tokens: 5,
          messages: [{ role: 'user', content: 'ping' }],
        }),
      });
      // 401 = invalid key, 200/400 = valid key (400 may be model/param error but key is valid)
      const valid = res.status !== 401 && res.status !== 403;
      return NextResponse.json({ ok: true, valid, status: res.status });
    }

    if (keyType === 'voyage') {
      const res = await fetch('https://api.voyageai.com/v1/embeddings', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${key}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ model: 'voyage-3', input: ['test'] }),
      });
      const valid = res.status !== 401 && res.status !== 403;
      return NextResponse.json({ ok: true, valid, status: res.status });
    }

    return NextResponse.json({ ok: false, error: '지원하지 않는 keyType' }, { status: 400 });
  } catch (err: any) {
    return NextResponse.json({ ok: false, error: err.message }, { status: 500 });
  }
}
