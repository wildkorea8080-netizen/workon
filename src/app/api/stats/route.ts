import { NextRequest, NextResponse } from 'next/server';
import { getServerAuthSession, isAdminSession } from '@/lib/auth';
import { supabaseAdmin } from '@/lib/supabaseAdmin';

export async function GET(_request: NextRequest) {
  try {
    const session = await getServerAuthSession();
    if (!session?.user?.id) {
      return NextResponse.json(
        { ok: false, error: { message: '인증이 필요합니다.' } },
        { status: 401 }
      );
    }

    // 부서 전체 집계는 관리자 화면(/admin/stats)이 쓴다. 직원용은
    // /api/my/stats 와 /api/employee/stats 가 따로 있다.
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

    // 기본 통계 조회
    const [
      { count: totalDocuments },
      { count: totalAgents },
      { count: totalConversations },
      { count: totalMessages },
      { count: totalReports },
      { count: totalTemplates },
      { count: totalUsers },
    ] = await Promise.all([
      supabaseAdmin
        .from('documents')
        .select('*', { count: 'exact', head: true })
        .eq('department_id', departmentId),
      supabaseAdmin
        .from('agents')
        .select('*', { count: 'exact', head: true })
        .eq('department_id', departmentId),
      supabaseAdmin
        .from('conversations')
        .select('*', { count: 'exact', head: true })
        .eq('department_id', departmentId),
      supabaseAdmin
        .from('messages')
        .select('id, conversations!inner(department_id)', { count: 'exact', head: true })
        .eq('conversations.department_id', departmentId),
      supabaseAdmin
        .from('report_templates')
        .select('*', { count: 'exact', head: true })
        .eq('department_id', departmentId),
      supabaseAdmin
        .from('report_templates')
        .select('*', { count: 'exact', head: true })
        .eq('department_id', departmentId)
        .eq('is_active', true),
      supabaseAdmin
        .from('users')
        .select('*', { count: 'exact', head: true })
        .eq('department_id', departmentId),
    ]);

    // 최근 활동 조회 (최근 7일)
    const sevenDaysAgo = new Date();
    sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 7);

    const { data: recentActivity, error: activityError } = await supabaseAdmin
      .from('usage_logs')
      .select('action, created_at')
      .eq('department_id', departmentId)
      .gte('created_at', sevenDaysAgo.toISOString())
      .order('created_at', { ascending: false })
      .limit(10);

    if (activityError) {
      console.error('[stats] 최근 활동 조회 오류:', activityError);
    }

    // 토큰 사용량 계산 (usage_logs에서 추출)
    const { data: tokenUsage } = await supabaseAdmin
      .from('usage_logs')
      .select('details')
      .eq('department_id', departmentId)
      .not('details', 'is', null);

    let totalTokens = 0;
    if (tokenUsage) {
      for (const log of tokenUsage) {
        if (log.details?.input_tokens && log.details?.output_tokens) {
          totalTokens += log.details.input_tokens + log.details.output_tokens;
        }
      }
    }

    // 최근 보고서 생성 수 (최근 30일)
    const thirtyDaysAgo = new Date();
    thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);

    const { count: recentReports } = await supabaseAdmin
      .from('report_templates')
      .select('*', { count: 'exact', head: true })
      .eq('department_id', departmentId)
      .gte('created_at', thirtyDaysAgo.toISOString());

    return NextResponse.json({
      ok: true,
      data: {
        totalDocuments: totalDocuments || 0,
        totalAgents: totalAgents || 0,
        totalConversations: totalConversations || 0,
        totalMessages: totalMessages || 0,
        totalReports: totalReports || 0,
        totalTemplates: totalTemplates || 0,
        totalUsers: totalUsers || 0,
        totalTokens,
        recentReports: recentReports || 0,
        recentActivity: recentActivity || [],
      },
    });
  } catch (error) {
    console.error('[stats] 오류:', error);
    return NextResponse.json(
      { ok: false, error: { message: '서버 오류가 발생했습니다.' } },
      { status: 500 }
    );
  }
}