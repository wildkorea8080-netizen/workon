import { NextRequest, NextResponse } from 'next/server';
import { getServerAuthSession } from '@/lib/auth';
import { supabaseAdmin } from '@/lib/supabaseAdmin';

// 현재 사용자의 보고서 생성 이력 조회
export async function GET(request: NextRequest) {
  try {
    const session = await getServerAuthSession();
    if (!session?.user?.id) {
      return NextResponse.json(
        { ok: false, error: { message: '인증이 필요합니다.' } },
        { status: 401 }
      );
    }

    const { searchParams } = new URL(request.url);
    const limit = Math.min(parseInt(searchParams.get('limit') || '20'), 100);

    const { data, error } = await supabaseAdmin
      .from('usage_logs')
      .select('id, details, created_at')
      .eq('user_id', session.user.id)
      .eq('action', 'generate_report')
      .order('created_at', { ascending: false })
      .limit(limit);

    if (error) {
      return NextResponse.json(
        { ok: false, error: { message: '보고서 목록 조회 실패' } },
        { status: 500 }
      );
    }

    const reports = (data || []).map((row) => ({
      id: row.id,
      template_name: (row.details as any)?.template_name ?? '알 수 없는 템플릿',
      report_content: (row.details as any)?.report_content ?? '',
      input_tokens: (row.details as any)?.input_tokens ?? 0,
      output_tokens: (row.details as any)?.output_tokens ?? 0,
      created_at: row.created_at,
    }));

    return NextResponse.json({ ok: true, data: reports });
  } catch {
    return NextResponse.json(
      { ok: false, error: { message: '서버 오류가 발생했습니다.' } },
      { status: 500 }
    );
  }
}
