import { NextRequest, NextResponse } from 'next/server';
import { getServerAuthSession } from '@/lib/auth';
import { supabaseAdmin } from '@/lib/supabaseAdmin';

export async function PATCH(request: NextRequest, { params }: { params: { id: string } }) {
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
    const { name, description, content, schema, is_active } = body;

    if (!name && !description && content === undefined && schema === undefined && is_active === undefined) {
      return NextResponse.json(
        { ok: false, error: { message: '업데이트할 필드가 없습니다.' } },
        { status: 400 }
      );
    }

    const updatePayload: Record<string, unknown> = {};
    if (name !== undefined) updatePayload.name = typeof name === 'string' ? name.trim() : name;
    if (description !== undefined) updatePayload.description = typeof description === 'string' ? description.trim() : description;
    if (content !== undefined) updatePayload.content = typeof content === 'string' ? content.trim() : content;
    if (schema !== undefined) updatePayload.schema = schema;
    if (is_active !== undefined) updatePayload.is_active = is_active;

    updatePayload.updated_by = session.user.id;

    const { data: template, error } = await supabaseAdmin
      .from('report_templates')
      .update(updatePayload)
      .eq('id', params.id)
      .eq('department_id', departmentId)
      .select()
      .single();

    if (error) {
      return NextResponse.json(
        { ok: false, error: { message: '템플릿 업데이트 중 오류가 발생했습니다.' } },
        { status: 500 }
      );
    }

    return NextResponse.json({ ok: true, data: template });
  } catch (error) {
    console.error('템플릿 업데이트 오류:', error);
    return NextResponse.json(
      { ok: false, error: { message: '서버 오류가 발생했습니다.' } },
      { status: 500 }
    );
  }
}

export async function DELETE(_request: NextRequest, { params }: { params: { id: string } }) {
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

    // 템플릿을 비활성화 (하드 삭제 대신)
    const { data: template, error } = await supabaseAdmin
      .from('report_templates')
      .update({ is_active: false })
      .eq('id', params.id)
      .eq('department_id', departmentId)
      .select()
      .single();

    if (error) {
      return NextResponse.json(
        { ok: false, error: { message: '템플릿 삭제 중 오류가 발생했습니다.' } },
        { status: 500 }
      );
    }

    return NextResponse.json({ ok: true, data: template });
  } catch (error) {
    console.error('템플릿 삭제 오류:', error);
    return NextResponse.json(
      { ok: false, error: { message: '서버 오류가 발생했습니다.' } },
      { status: 500 }
    );
  }
}
