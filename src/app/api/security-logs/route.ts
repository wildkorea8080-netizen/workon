import { NextRequest, NextResponse } from 'next/server';
import { getServerAuthSession, isAdminSession } from '@/lib/auth';
import { supabaseAdmin } from '@/lib/supabaseAdmin';
import type { ApiResponse } from '@/lib/db';

export async function GET(request: NextRequest) {
  try {
    const session = await getServerAuthSession();
    if (!session?.user?.id) {
      return NextResponse.json(
        { ok: false, error: { message: '인증이 필요합니다.' } },
        { status: 401 }
      );
    }

    if (!isAdminSession(session)) {
      return NextResponse.json(
        { ok: false, error: { message: '관리자 권한이 필요합니다.' } },
        { status: 403 }
      );
    }

    // 사용자의 부서 확인
    const { data: user, error: userError } = await supabaseAdmin
      .from('users')
      .select('department_id')
      .eq('id', session.user.id)
      .single();

    if (userError || !user?.department_id) {
      return NextResponse.json(
        { ok: false, error: { message: '부서 정보를 찾을 수 없습니다.' } },
        { status: 403 }
      );
    }

    // 쿼리 파라미터 처리
    const { searchParams } = new URL(request.url);
    const limit = Math.min(parseInt(searchParams.get('limit') || '50'), 200);
    const offset = parseInt(searchParams.get('offset') || '0');
    const eventType = searchParams.get('event_type');
    const severity = searchParams.get('severity');

    let query = supabaseAdmin
      .from('security_logs')
      .select(`
        *,
        users:user_id (
          name,
          email
        )
      `)
      .eq('department_id', user.department_id)
      .order('created_at', { ascending: false })
      .range(offset, offset + limit - 1);

    if (eventType) {
      query = query.eq('event_type', eventType);
    }

    if (severity) {
      query = query.eq('severity', severity);
    }

    const { data: logs, error } = await query;

    if (error) {
      return NextResponse.json(
        { ok: false, error: { message: '보안 로그 조회 중 오류가 발생했습니다.' } },
        { status: 500 }
      );
    }

    // 전체 개수 조회
    let countQuery = supabaseAdmin
      .from('security_logs')
      .select('id', { count: 'exact' })
      .eq('department_id', user.department_id);

    if (eventType) {
      countQuery = countQuery.eq('event_type', eventType);
    }

    if (severity) {
      countQuery = countQuery.eq('severity', severity);
    }

    const { count } = await countQuery;

    return NextResponse.json({
      ok: true,
      data: {
        logs: logs || [],
        total: count || 0,
        limit,
        offset,
      }
    });
  } catch (error) {
    console.error('보안 로그 조회 오류:', error);
    return NextResponse.json(
      { ok: false, error: { message: '서버 오류가 발생했습니다.' } },
      { status: 500 }
    );
  }
}