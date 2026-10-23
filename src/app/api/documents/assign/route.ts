import { NextRequest, NextResponse } from 'next/server';
import { getServerAuthSession, isAdminSession } from '@/lib/auth';
import { supabaseAdmin } from '@/lib/supabaseAdmin';
import { getActorScope } from '@/lib/actor-scope';
import { canEditAgent, type AgentAccessInfo } from '@/lib/agent-permissions';
import { loadAgentAccess, recordAgentEvent, enableAgentCapability } from '@/lib/agent-store';
import {
  ASSIGN_SOURCE_COLUMNS,
  canReadDocument,
  buildAssignedDocumentRow,
  type AssignSourceDocument,
} from '@/lib/document-files';

export const dynamic = 'force-dynamic';

// POST: 기존 문서를 추가 에이전트에 연결
//
// 업로드 라우트와 같은 규칙을 따른다 — 고른 비서 전부를 권한 모듈로 검사하고,
// 새 행은 비서 단계에 맞춘 공개 범위로 만들고, 붙인 비서의 문서 찾기를 켠다.
export async function POST(request: NextRequest) {
  const session = await getServerAuthSession();
  if (!session?.user?.id || !isAdminSession(session)) {
    return NextResponse.json({ ok: false, error: { message: '관리자 권한이 필요합니다.' } }, { status: 403 });
  }

  try {
    const { documentId, agentIds: rawAgentIds } = await request.json();
    if (typeof documentId !== 'string' || !documentId || !Array.isArray(rawAgentIds) || rawAgentIds.length === 0) {
      return NextResponse.json({ ok: false, error: { message: 'documentId, agentIds 필수' } }, { status: 400 });
    }
    // 같은 id가 두 번 오면 행이 둘 생긴다. 처음에 한 번 걸러 권한 검사와 행 만들기가 같은 목록을 쓰게 한다.
    const agentIds: string[] = [...new Set(rawAgentIds.filter((id: unknown): id is string => typeof id === 'string' && id.length > 0))];
    if (agentIds.length === 0) {
      return NextResponse.json({ ok: false, error: { message: 'documentId, agentIds 필수' } }, { status: 400 });
    }

    // 소속을 알 수 없으면 거부한다. 추측해서 배정하지 않는다(CLAUDE.md 구조적 위험 0).
    const actor = await getActorScope(session);
    if (!actor || !actor.organizationId) {
      return NextResponse.json({ ok: false, error: { message: '소속 부서가 지정되지 않았습니다.' } }, { status: 403 });
    }

    // 원본 문서 — 요청자 기관으로 한정한다. 예전에는 id만으로 찾아 타 기관 문서의
    // 본문·임베딩을 내 비서로 복사할 수 있었다. 기관이 다르거나 볼 수 없는 문서는
    // 존재를 알리지 않는다(404).
    const { data: srcRow } = await supabaseAdmin
      .from('documents')
      .select(ASSIGN_SOURCE_COLUMNS)
      .eq('id', documentId)
      .eq('organization_id', actor.organizationId)
      .maybeSingle();
    const src = srcRow as AssignSourceDocument | null;

    if (!src || !canReadDocument(src, actor)) {
      return NextResponse.json({ ok: false, error: { message: '원본 문서를 찾을 수 없습니다.' } }, { status: 404 });
    }

    // 고른 비서 전부를 검사한다. 첫 번째만 보면 뒤에 붙인 남의 비서에 문서가 붙는다.
    const targets = new Map<string, AgentAccessInfo>();
    for (const id of agentIds) {
      const target = await loadAgentAccess(id);
      if (!target || !canEditAgent(target, actor)) {
        return NextResponse.json(
          { ok: false, error: { message: '문서를 붙일 권한이 없는 비서가 포함돼 있습니다.' } },
          { status: 403 }
        );
      }
      targets.set(id, target);
    }

    // 이미 이 문서의 storage_path가 연결된 에이전트 목록
    const { data: existing, error: existingErr } = await supabaseAdmin
      .from('documents')
      .select('agent_id')
      .eq('storage_path', src.storage_path);
    if (existingErr) throw existingErr;

    const alreadyLinked = new Set((existing ?? []).map((d: { agent_id: string | null }) => d.agent_id));
    const newAgentIds = agentIds.filter((id) => !alreadyLinked.has(id));

    if (newAgentIds.length === 0) {
      return NextResponse.json({ ok: false, error: { message: '선택한 비서들은 이미 이 문서가 등록되어 있습니다.' } }, { status: 409 });
    }

    // 새 연결 레코드 생성: 저장소 파일은 공유하고, 읽기는 비서마다 새로 한다(새 id·NODA 파일 이름·reading).
    // 행마다 키 집합이 같다. 읽기 호출은 화면이 목록을 열 때 시작한다(맞추기·kick).
    const now = new Date();
    const newRows = newAgentIds.map((id) => buildAssignedDocumentRow(src, targets.get(id)!, crypto.randomUUID(), now));

    const { data: inserted, error: insErr } = await supabaseAdmin
      .from('documents')
      .insert(newRows)
      .select('id, agent_id');

    if (insErr) throw insErr;

    // 업로드와 같다: 비서 타임라인에 남기고 문서 찾기를 켠다. 켜지 않으면 연결해도
    // 그 비서는 문서를 찾지 못한다(doc_search가 켜진 비서만 찾는다).
    for (const id of newAgentIds) {
      await recordAgentEvent(id, 'document_added', session.user.id, { file_name: src.file_name });
      await enableAgentCapability(id, 'doc_search', session.user.id);
    }

    return NextResponse.json({ ok: true, data: { added: inserted?.length ?? 0, documentIds: (inserted ?? []).map((r: { id: string }) => r.id) } });
  } catch (err: any) {
    console.error('[documents/assign]', err);
    return NextResponse.json({ ok: false, error: { message: err.message } }, { status: 500 });
  }
}
