import { NextRequest, NextResponse } from 'next/server';
import { getServerAuthSession } from '@/lib/auth';
import { supabaseAdmin } from '@/lib/supabaseAdmin';
import { webhookView, type AppWebhookRowLike, WEBHOOK_COLUMNS } from '@/lib/apps/webhook-spec';

export const dynamic = 'force-dynamic';
const fail = (message: string, status: number) => NextResponse.json({ ok: false, error: { message } }, { status });
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** 연동 회수 — 내 것만. 행은 지우지 않고 회수 도장을 찍는다(사용 기록이 남게). 이미 회수된 연동도 그대로 성공 */
export async function DELETE(_request: NextRequest, { params }: { params: { id: string } }) {
  const session = await getServerAuthSession();
  if (!session?.user?.id) return fail('인증이 필요합니다.', 401);
  if (!UUID.test(params.id)) return fail('연동을 확인해 주세요.', 400);
  const now = new Date().toISOString();
  const { error } = await supabaseAdmin.from('app_webhooks').update({ status: 'revoked', revoked_at: now, updated_at: now })
    .eq('id', params.id).eq('user_id', session.user.id).eq('status', 'active');
  if (error) return fail('연동을 회수하지 못했습니다.', 503);
  const { data: row, error: readError } = await supabaseAdmin.from('app_webhooks').select(`${WEBHOOK_COLUMNS}, agent:agents(name)`)
    .eq('id', params.id).eq('user_id', session.user.id).maybeSingle();
  if (readError) return fail('연동을 불러오지 못했습니다.', 503);
  if (!row) return fail('연동을 찾을 수 없습니다.', 404);
  const agent = (row as { agent: { name: string } | { name: string }[] | null }).agent;
  return NextResponse.json({ ok: true, data: webhookView(row as AppWebhookRowLike, (Array.isArray(agent) ? agent[0]?.name : agent?.name) ?? null, Date.now()) });
}
