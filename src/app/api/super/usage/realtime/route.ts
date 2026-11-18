import { NextRequest, NextResponse } from 'next/server';
import { getSuperAdminFromRequest } from '@/lib/super-auth';
import { supabaseAdmin } from '@/lib/supabaseAdmin';
import { pagedRows } from '@/lib/paged-select';
import { chatTokensOf } from '@/lib/org-chat-tokens';

export const dynamic = 'force-dynamic';

export async function GET(request: NextRequest) {
  if (!getSuperAdminFromRequest(request))
    return NextResponse.json({ ok: false, error: '인증 필요' }, { status: 401 });

  const now     = new Date();
  const oneHourAgo = new Date(now.getTime() - 3600000);
  const fiveMinAgo = new Date(now.getTime() -  300000);

  const { data: hourLogs, error } = await pagedRows<{ user_id?: string; details: any; created_at: string }>((a, b, w) => supabaseAdmin
    .from('usage_logs')
    .select('user_id, details, created_at', w ? { count: 'exact' } : undefined)
    .eq('action', 'chat_message')
    .gte('created_at', oneHourAgo.toISOString())
    .order('id').range(a, b));

  // 못 읽으면 '활성 0명·대화 0건'으로 보이지 않는다(2026-11-18)
  if (error) return NextResponse.json({ ok: false, error: '실시간 사용량을 불러오지 못했습니다. 잠시 뒤 다시 시도해 주세요.' }, { status: 503 });
  const rows = hourLogs ?? [];
  const activeNow = new Set(
    rows.filter((r: { created_at: string; user_id?: string }) => new Date(r.created_at) >= fiveMinAgo && r.user_id).map((r: { user_id?: string }) => r.user_id)
  ).size;

  // 숫자만(한도 판정과 같은 셈 — 예전엔 글자 값이 이어 붙어 합계가 망가질 수 있었다)
  const lastHourTokens = rows.reduce((s: number, r: { details?: unknown }) => s + chatTokensOf(r.details), 0);

  return NextResponse.json({
    ok: true,
    data: {
      activeNow,
      lastHourConversations: rows.length,
      lastHourTokens,
      timestamp: now.toISOString(),
    },
  });
}
