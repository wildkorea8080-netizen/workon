import { NextRequest, NextResponse } from 'next/server';
import { getServerAuthSession } from '@/lib/auth';
import { supabaseAdmin } from '@/lib/supabaseAdmin';
import { getAccessScope, visibilityFilter } from '@/lib/department-scope';

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

    // 기관 전체 공개 문서 + 내 부서 계통에 걸린 부서 제한 문서
    const scope = await getAccessScope(departmentId);
    const visibleFilter = visibilityFilter(scope);

    const { data, error } = await supabaseAdmin
      .from('documents')
      .select('id, department_id, agent_id, uploaded_by, file_name, file_type, title, summary, visibility, created_at, updated_at')
      .or(visibleFilter)
      .order('created_at', { ascending: false });

    if (error) {
      return NextResponse.json(
        { ok: false, error: { message: '문서 목록 조회 실패', details: error } },
        { status: 500 }
      );
    }

    return NextResponse.json({ ok: true, data: data || [] });
  } catch (error) {
    return NextResponse.json(
      { ok: false, error: { message: '서버 오류가 발생했습니다.' } },
      { status: 500 }
    );
  }
}

export async function DELETE(request: NextRequest) {
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

    const { documentId } = await request.json();
    if (!documentId) {
      return NextResponse.json(
        { ok: false, error: { message: 'documentId가 필요합니다.' } },
        { status: 400 }
      );
    }

    // Verify the document belongs to this department before deleting
    const { data: doc } = await supabaseAdmin
      .from('documents')
      .select('id, storage_path')
      .eq('id', documentId)
      .eq('department_id', departmentId)
      .single();

    if (!doc) {
      return NextResponse.json(
        { ok: false, error: { message: '문서를 찾을 수 없습니다.' } },
        { status: 404 }
      );
    }

    // Delete storage file
    if (doc.storage_path) {
      await supabaseAdmin.storage.from('documents').remove([doc.storage_path]);
    }

    const { error } = await supabaseAdmin
      .from('documents')
      .delete()
      .eq('id', documentId)
      .eq('department_id', departmentId);

    if (error) {
      return NextResponse.json(
        { ok: false, error: { message: '문서 삭제 실패', details: error } },
        { status: 500 }
      );
    }

    return NextResponse.json({ ok: true, data: { deleted: true } });
  } catch (error) {
    return NextResponse.json(
      { ok: false, error: { message: '서버 오류가 발생했습니다.' } },
      { status: 500 }
    );
  }
}
