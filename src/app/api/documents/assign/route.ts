import { NextRequest, NextResponse } from 'next/server';
import { getServerAuthSession, isAdminSession } from '@/lib/auth';
import { supabaseAdmin } from '@/lib/supabaseAdmin';

export const dynamic = 'force-dynamic';

// POST: 기존 문서를 추가 에이전트에 연결
export async function POST(request: NextRequest) {
  const session = await getServerAuthSession();
  if (!session?.user?.id || !isAdminSession(session)) {
    return NextResponse.json({ ok: false, error: { message: '관리자 권한이 필요합니다.' } }, { status: 403 });
  }

  try {
    const { documentId, agentIds } = await request.json();
    if (!documentId || !Array.isArray(agentIds) || agentIds.length === 0) {
      return NextResponse.json({ ok: false, error: { message: 'documentId, agentIds 필수' } }, { status: 400 });
    }

    // 원본 문서 조회
    const { data: src, error: srcErr } = await supabaseAdmin
      .from('documents')
      .select('*')
      .eq('id', documentId)
      .single();

    if (srcErr || !src) {
      return NextResponse.json({ ok: false, error: { message: '원본 문서를 찾을 수 없습니다.' } }, { status: 404 });
    }

    // 이미 이 문서의 storage_path가 연결된 에이전트 목록
    const { data: existing } = await supabaseAdmin
      .from('documents')
      .select('agent_id')
      .eq('storage_path', src.storage_path);

    const alreadyLinked = new Set((existing ?? []).map((d: any) => d.agent_id));
    const newAgentIds   = agentIds.filter((id: string) => !alreadyLinked.has(id));

    if (newAgentIds.length === 0) {
      return NextResponse.json({ ok: false, error: { message: '선택한 비서들은 이미 이 문서가 등록되어 있습니다.' } }, { status: 409 });
    }

    // 새 연결 레코드 생성 (storage_path, metadata, embedding 공유)
    const newRows = newAgentIds.map((agentId: string) => ({
      department_id: src.department_id,
      uploaded_by:   src.uploaded_by,
      agent_id:      agentId,
      storage_path:  src.storage_path,
      file_name:     src.file_name,
      file_type:     src.file_type,
      title:         src.title,
      summary:       src.summary,
      metadata:      src.metadata,
      embedding:     src.embedding,
    }));

    const { data: inserted, error: insErr } = await supabaseAdmin
      .from('documents')
      .insert(newRows)
      .select('id, agent_id');

    if (insErr) throw insErr;

    return NextResponse.json({ ok: true, data: { added: inserted?.length ?? 0 } });
  } catch (err: any) {
    console.error('[documents/assign]', err);
    return NextResponse.json({ ok: false, error: { message: err.message } }, { status: 500 });
  }
}
