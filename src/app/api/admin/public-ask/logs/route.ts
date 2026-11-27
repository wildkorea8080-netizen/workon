import { NextResponse, type NextRequest } from 'next/server';
import { getServerAuthSession, isAdminSession } from '@/lib/auth';
import { actorScopeOr503 } from '@/lib/actor-scope-response';
import { supabaseAdmin } from '@/lib/supabaseAdmin';

export const dynamic = 'force-dynamic';

function jsonError(message: string, status: number) {
  return NextResponse.json({ ok: false, error: { message } }, { status });
}

/**
 * 시민 상담 기록(2026-11-27, 0136) — 기관 전체 관리자만, 최근 30일 중 200줄. `?noSource=1`이면 근거를 찾지 못한 질문만
 * (문서를 보강할 곳을 찾으려는 것). IP 해시는 내보내지 않는다. 못 읽으면 503(빈 기록으로 보이지 않게)
 */
export async function GET(request: NextRequest) {
  const session = await getServerAuthSession();
  if (!session?.user?.id || !isAdminSession(session)) return jsonError('관리자 권한이 필요합니다.', 403);
  const actor = await actorScopeOr503(session);
  if (actor instanceof Response) return actor;
  if (!actor?.organizationId) return jsonError('소속 기관을 확인할 수 없습니다.', 403);
  if (!actor.managesWholeOrganization) return jsonError('시민 상담 기록은 기관 전체 관리자만 봅니다.', 403);

  let query = supabaseAdmin
    .from('public_ask_logs')
    .select('id, created_at, result, question, answer, sources')
    .eq('organization_id', actor.organizationId)
    .order('created_at', { ascending: false })
    .limit(200);
  if (request.nextUrl.searchParams.get('noSource') === '1') query = query.eq('result', 'no_source');
  const { data, error } = await query;
  if (error) return jsonError('시민 상담 기록을 지금 읽지 못했습니다. 잠시 뒤 다시 시도해 주세요.', 503);

  // 최근 24시간 결과별 수 — 줄을 읽어 세면 1,000행 상한에 걸리므로 결과마다 수만 센다
  const since = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
  const results = ['answered', 'no_source', 'rejected_pii', 'capped_ip', 'capped_org', 'unavailable'] as const;
  const counted = await Promise.all(results.map((r) => supabaseAdmin.from('public_ask_logs').select('id', { count: 'exact', head: true })
    .eq('organization_id', actor.organizationId as string).eq('result', r).gte('created_at', since)));
  if (counted.some((c: { error: unknown }) => c.error)) return jsonError('시민 상담 기록을 지금 읽지 못했습니다. 잠시 뒤 다시 시도해 주세요.', 503);
  const today = Object.fromEntries(results.map((r, i) => [r, counted[i].count ?? 0]));
  return NextResponse.json({ ok: true, data: { logs: data ?? [], last24h: today } });
}
