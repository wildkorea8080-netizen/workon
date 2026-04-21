import { NextRequest, NextResponse } from 'next/server';
import { getServerAuthSession } from '@/lib/auth';
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

    const departmentId = session.user.departmentId;
    if (!departmentId) {
      return NextResponse.json(
        { ok: false, error: { message: '부서 정보를 찾을 수 없습니다.' } },
        { status: 403 }
      );
    }

    const { data: templates, error } = await supabaseAdmin
      .from('report_templates')
      .select('*')
      .eq('department_id', departmentId)
      .eq('is_active', true)
      .order('created_at', { ascending: false });

    if (error) {
      return NextResponse.json(
        { ok: false, error: { message: '템플릿 조회 중 오류가 발생했습니다.' } },
        { status: 500 }
      );
    }

    return NextResponse.json({ ok: true, data: templates });
  } catch (error) {
    console.error('템플릿 목록 조회 오류:', error);
    return NextResponse.json(
      { ok: false, error: { message: '서버 오류가 발생했습니다.' } },
      { status: 500 }
    );
  }
}

export async function POST(request: NextRequest) {
  try {
    const session = await getServerAuthSession();
    if (!session?.user?.id) {
      return NextResponse.json(
        { ok: false, error: { message: '인증이 필요합니다.' } },
        { status: 401 }
      );
    }

    if (session.user.role !== 'ADMIN') {
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

    const body = await request.json();
    const { name, description, content, schema } = body;

    if (!name || typeof name !== 'string' || name.trim().length === 0) {
      return NextResponse.json(
        { ok: false, error: { message: '템플릿 이름은 필수입니다.' } },
        { status: 400 }
      );
    }

    if (!content || typeof content !== 'string' || content.trim().length === 0) {
      return NextResponse.json(
        { ok: false, error: { message: '템플릿 내용은 필수입니다.' } },
        { status: 400 }
      );
    }

    const { data: template, error } = await supabaseAdmin
      .from('report_templates')
      .insert({
        department_id: departmentId,
        created_by: session.user.id,
        name: name.trim(),
        description: description?.trim(),
        content: content.trim(),
        schema: schema || {},
        version: 1,
      })
      .select()
      .single();

    if (error) {
      if (error.code === '23505') {
        return NextResponse.json(
          { ok: false, error: { message: '동일한 이름의 템플릿이 이미 존재합니다.' } },
          { status: 409 }
        );
      }
      return NextResponse.json(
        { ok: false, error: { message: '템플릿 생성 중 오류가 발생했습니다.' } },
        { status: 500 }
      );
    }

    return NextResponse.json({ ok: true, data: template }, { status: 201 });
  } catch (error) {
    console.error('템플릿 생성 오류:', error);
    return NextResponse.json(
      { ok: false, error: { message: '서버 오류가 발생했습니다.' } },
      { status: 500 }
    );
  }
}
