import { NextRequest, NextResponse } from 'next/server';
import { getSuperAdminFromRequest } from '@/lib/super-auth';
import { supabaseAdmin } from '@/lib/supabaseAdmin';

export const dynamic = 'force-dynamic';

export async function GET(request: NextRequest) {
  if (!getSuperAdminFromRequest(request))
    return NextResponse.json({ ok: false, error: '인증 필요' }, { status: 401 });

  const now     = new Date();
  const oneHourAgo = new Date(now.getTime() - 3600000);
  const fiveMinAgo = new Date(now.getTime() -  300000);

  const { data: hourLogs } = await supabaseAdmin
    .from('usage_logs')
    .select('user_id, details, created_at')
    .eq('action', 'chat_message')
    .gte('created_at', oneHourAgo.toISOString());

  const rows = hourLogs ?? [];
  const activeNow = new Set(
    rows.filter(r => new Date(r.created_at) >= fiveMinAgo && r.user_id).map(r => r.user_id)
  ).size;

  const lastHourTokens = rows.reduce((s, r) =>
    s + ((r.details?.input_tokens ?? 0) + (r.details?.output_tokens ?? 0)), 0);

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
