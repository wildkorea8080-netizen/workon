import { NextRequest, NextResponse } from 'next/server';
import { getServerAuthSession } from '@/lib/auth';
import { supabaseAdmin } from '@/lib/supabaseAdmin';
import { getAccessScope, visibilityFilter } from '@/lib/department-scope';
import { getActorScope } from '@/lib/actor-scope';
import { canDeleteAgent } from '@/lib/agent-permissions';
import { loadAgentAccess, recordAgentEvent } from '@/lib/agent-store';
import { removeStorageFileIfUnused } from '@/lib/document-files';

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
      return NextResponse.json({ ok: false, error: { message: '인증이 필요합니다.' } }, { status: 401 });
    }

    const actor = await getActorScope(session);
    if (!actor) {
      return NextResponse.json({ ok: false, error: { message: '부서 정보를 찾을 수 없습니다.' } }, { status: 403 });
    }

    const { documentId } = await request.json();
    if (!documentId) {
      return NextResponse.json({ ok: false, error: { message: 'documentId가 필요합니다.' } }, { status: 400 });
    }

    const { data: doc } = await supabaseAdmin
      .from('documents')
      .select('id, storage_path, agent_id, department_id, file_name')
      .eq('id', documentId)
      .maybeSingle();

    if (!doc) {
      return NextResponse.json({ ok: false, error: { message: '문서를 찾을 수 없습니다.' } }, { status: 404 });
    }

    // 문서는 되돌리기 대상이 아니다(결정 3). 되돌릴 수 없는 것은 좁게 연다 —
    // 그 비서를 지울 수 있는 사람만 문서도 지운다(결정 4의 원칙).
    // 비서에 걸리지 않은 문서는 그 부서를 관리하는 관리자만.
    let allowed = false;
    if (doc.agent_id) {
      const agent = await loadAgentAccess(doc.agent_id);
      allowed = Boolean(agent) && canDeleteAgent(agent!, actor);
    } else {
      allowed = actor.isAdmin && actor.managedDepartmentIds.includes(doc.department_id);
    }
    if (!allowed) {
      return NextResponse.json({ ok: false, error: { message: '이 문서를 지울 권한이 없습니다.' } }, { status: 403 });
    }

    const { error } = await supabaseAdmin.from('documents').delete().eq('id', documentId);
    if (error) {
      return NextResponse.json({ ok: false, error: { message: '문서 삭제 실패', details: error } }, { status: 500 });
    }

    // 여러 비서에 한 번에 올린 문서는 저장소 파일 하나를 함께 쓴다.
    // 다른 행이 남아 있거나 세지 못하면 파일을 지우지 않는다.
    if (doc.storage_path) await removeStorageFileIfUnused(doc.storage_path);

    if (doc.agent_id) {
      await recordAgentEvent(doc.agent_id, 'document_removed', actor.userId, { file_name: doc.file_name });
    }

    return NextResponse.json({ ok: true, data: { deleted: true } });
  } catch (error) {
    return NextResponse.json({ ok: false, error: { message: '서버 오류가 발생했습니다.' } }, { status: 500 });
  }
}
