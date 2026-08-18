import { NextRequest, NextResponse } from 'next/server';
import { getServerAuthSession } from '@/lib/auth';
import { supabaseAdmin } from '@/lib/supabaseAdmin';
import { connectorCatalog } from '@/lib/connectors';

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
    const { name, description, system_prompt, config, is_active, enabled_connectors, visibility } = body;

    if (
      !name &&
      !description &&
      system_prompt === undefined &&
      config === undefined &&
      is_active === undefined &&
      enabled_connectors === undefined &&
      visibility === undefined
    ) {
      return NextResponse.json(
        { ok: false, error: { message: '업데이트할 필드가 없습니다.' } },
        { status: 400 }
      );
    }

    const updatePayload: Record<string, unknown> = {};
    if (name !== undefined) updatePayload.name = typeof name === 'string' ? name.trim() : name;
    if (description !== undefined) updatePayload.description = typeof description === 'string' ? description.trim() : description;
    if (system_prompt !== undefined) updatePayload.system_prompt = typeof system_prompt === 'string' ? system_prompt.trim() : system_prompt;
    if (config !== undefined) updatePayload.config = config;
    if (is_active !== undefined) updatePayload.is_active = is_active;

    if (enabled_connectors !== undefined) {
      // 존재하지 않는 커넥터 id가 저장되면 조용히 무시될 뿐이지만,
      // 설정 화면이 실제와 어긋나 보이므로 여기서 걸러낸다.
      const known = new Set(connectorCatalog().map((c) => c.id));
      updatePayload.enabled_connectors = Array.isArray(enabled_connectors)
        ? enabled_connectors.filter((id: unknown) => typeof id === 'string' && known.has(id))
        : [];
    }

    if (visibility !== undefined) {
      if (!['organization', 'department'].includes(visibility)) {
        return NextResponse.json(
          { ok: false, error: { message: "공개 범위는 'organization' 또는 'department'만 가능합니다." } },
          { status: 400 }
        );
      }
      updatePayload.visibility = visibility;
    }

    updatePayload.updated_by = session.user.id;

    const { data: agent, error } = await supabaseAdmin
      .from('agents')
      .update(updatePayload)
      .eq('id', params.id)
      .eq('department_id', departmentId)
      .select()
      .single();

    if (error) {
      return NextResponse.json(
        { ok: false, error: { message: '에이전트 업데이트 중 오류가 발생했습니다.' } },
        { status: 500 }
      );
    }

    return NextResponse.json({ ok: true, data: agent });
  } catch (error) {
    console.error('Agent update error:', error);
    return NextResponse.json(
      { ok: false, error: { message: '서버 오류가 발생했습니다.', details: error instanceof Error ? error.message : String(error) } },
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

    const { error } = await supabaseAdmin
      .from('agents')
      .delete()
      .eq('id', params.id)
      .eq('department_id', departmentId);

    if (error) {
      return NextResponse.json(
        { ok: false, error: { message: '에이전트 삭제 중 오류가 발생했습니다.' } },
        { status: 500 }
      );
    }

    return NextResponse.json({ ok: true });
  } catch (error) {
    console.error('Agent delete error:', error);
    return NextResponse.json(
      { ok: false, error: { message: '서버 오류가 발생했습니다.' } },
      { status: 500 }
    );
  }
}
