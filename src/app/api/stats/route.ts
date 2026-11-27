import { NextRequest, NextResponse } from 'next/server';
import { getServerAuthSession, isAdminSession } from '@/lib/auth';
import { supabaseAdmin } from '@/lib/supabaseAdmin';
import { pagedRows } from '@/lib/paged-select';
import { managedDepartmentIdsOr503 } from '@/lib/managed-scope-response';
import { chatTokensOf } from '@/lib/org-chat-tokens';
import { kstMonthStart } from '@/lib/kst-time';

export const dynamic = 'force-dynamic';

/**
 * 관리자 대시보드·통계 화면의 첫 카드(문서·비서·사용자·대화·메시지·이번 달 토큰)와 최근 활동.
 *
 * 2026-11-18에 고친 것:
 * - **관리 범위로 센다**(자기 부서 + 하위, 기관 직속 부서 관리자는 기관 전체). 예전에는 자기 부서 한 곳만 세어,
 *   같은 화면 아래 '사용량 추이'·이용통계(관리 범위)와 숫자가 어긋났고 기관 전체 관리자의 첫 화면이 거의 0이었다
 * - 지운 비서·나만의 비서, 탈퇴·사용 중지 계정, 지난 판 문서는 세지 않는다(예전엔 다 셌다)
 * - 토큰은 **이번 달(한국 시간)** 만 — 예전에는 화면을 열 때마다 부서의 모든 사용 기록을 끝까지 읽어 더했다
 * - 읽기 실패는 0이 아니라 503
 * - 옛 보고서 템플릿 수를 '생성된 보고서'로, 늘 '정상'인 시스템 상태를 보이던 카드는 뺐다
 */

class StatsReadError extends Error {}

type CountResult = { count: number | null; error: unknown };

async function countOf(query: PromiseLike<CountResult>): Promise<number> {
  const { count, error } = await query;
  if (error || typeof count !== 'number') throw new StatsReadError();
  return count;
}

export async function GET(_request: NextRequest) {
  try {
    const session = await getServerAuthSession();
    if (!session?.user?.id) {
      return NextResponse.json(
        { ok: false, error: { message: '인증이 필요합니다.' } },
        { status: 401 }
      );
    }

    // 직원용은 /api/my/stats 가 따로 있다.
    if (!isAdminSession(session)) {
      return NextResponse.json(
        { ok: false, error: { message: '관리자 권한이 필요합니다.' } },
        { status: 403 }
      );
    }

    const departmentId = session.user.departmentId;
    if (!departmentId) {
      return NextResponse.json(
        { ok: false, error: { message: '부서 정보를 찾을 수 없습니다.' } },
        { status: 403 }
      );
    }

    // 다른 관리자 화면(사용량 추이·이용통계·감사)과 같은 범위 — 못 읽으면 자기 부서만(좁히는 쪽)
    const managed = await managedDepartmentIdsOr503(departmentId);
    if (managed instanceof Response) return managed;
    const head = { count: 'exact' as const, head: true };

    const [totalDocuments, totalAgents, totalConversations, totalMessages, totalUsers] = await Promise.all([
      // 지난 판(개정으로 내려간 문서)은 근거로 쓰지 않으므로 세지 않는다
      countOf(supabaseAdmin.from('documents').select('id', head).in('department_id', managed).is('retired_at', null)),
      // 지운 비서(숨김)와 나만의 비서는 기관이 운영하는 비서가 아니다
      countOf(supabaseAdmin.from('agents').select('id', head).in('department_id', managed).is('deleted_at', null).neq('tier', 'personal').neq('tier', 'public')),
      countOf(supabaseAdmin.from('conversations').select('id', head).in('department_id', managed)),
      countOf(
        supabaseAdmin
          .from('messages')
          .select('id, conversations!inner(department_id)', head)
          .in('conversations.department_id', managed)
      ),
      // 인원 상한(`checkUserSeats`)과 같은 규칙 — 사용 중이고 탈퇴하지 않은 계정
      countOf(supabaseAdmin.from('users').select('id', head).in('department_id', managed).is('deleted_at', null).eq('is_active', true)),
    ]);

    // 이번 달(한국 시간) 토큰 — 토큰을 쓴 모든 활동, 숫자가 아니면 0. 쪽마다 끝까지(1,000행 상한에서 덜 세지 않게)
    const monthStart = kstMonthStart(new Date(), 0).toISOString();
    const { data: tokenRows, error: tokenError } = await pagedRows<{ details: unknown }>((a, b, withCount) =>
      supabaseAdmin
        .from('usage_logs')
        .select('details', withCount ? { count: 'exact' } : undefined)
        .in('department_id', managed)
        .gte('created_at', monthStart)
        .order('id')
        .range(a, b)
    );
    if (tokenError) throw new StatsReadError();
    let monthlyTokens = 0;
    for (const row of tokenRows ?? []) monthlyTokens += chatTokensOf(row.details);

    // 최근 활동(7일) — 무엇을 했는지와 때만. 누가·무슨 내용인지는 싣지 않는다
    const { data: recentActivity, error: activityError } = await supabaseAdmin
      .from('usage_logs')
      .select('action, created_at')
      .in('department_id', managed)
      .gte('created_at', new Date(Date.now() - 7 * 86400000).toISOString())
      .order('created_at', { ascending: false })
      .limit(10);
    if (activityError) throw new StatsReadError();

    return NextResponse.json({
      ok: true,
      data: {
        departmentCount: managed.length,
        totalDocuments,
        totalAgents,
        totalConversations,
        totalMessages,
        totalUsers,
        monthlyTokens,
        recentActivity: recentActivity ?? [],
      },
    });
  } catch (error) {
    if (error instanceof StatsReadError) {
      return NextResponse.json(
        { ok: false, error: { message: '통계를 지금 불러오지 못했습니다. 잠시 뒤 다시 시도해 주세요.' } },
        { status: 503 }
      );
    }
    console.error('[stats] 오류:', error);
    return NextResponse.json(
      { ok: false, error: { message: '서버 오류가 발생했습니다.' } },
      { status: 500 }
    );
  }
}
