import { NextResponse } from 'next/server';
import { getServerAuthSession, isAdminSession } from '@/lib/auth';
import { actorScopeOr503 } from '@/lib/actor-scope-response';
import { supabaseAdmin } from '@/lib/supabaseAdmin';
import { logSecurityEvent } from '@/lib/security-log';

export const dynamic = 'force-dynamic';

function jsonError(message: string, status: number) {
  return NextResponse.json({ ok: false, error: { message } }, { status });
}

const PUBLIC_AGENT_DEFAULT_PROMPT = `당신은 우리 기관을 찾은 시민의 질문에 답하는 민원 상담 도우미입니다.

지키는 것
- 기관이 올린 안내 자료(이용 안내·규정·요금·절차)에 있는 내용만 답합니다
- 자료에 없으면 짐작하지 말고 담당 부서로 문의하도록 안내합니다
- 공손하고 쉬운 말로, 결론을 먼저 짧게 답합니다`;

/**
 * 시민 전용 비서 만들기(2026-11-27, 0136) — 기관에 하나(DB 유일 색인), 기관 전체 관리자만·대리 접근 403.
 * 최상위 부서(요청자 부서) 소속, 능력은 문서 찾기만. 이름·지시문·문서는 비서 편집 창에서 고친다(권한은 canEditAgent — 기관 전체 관리자)
 */
export async function POST() {
  const session = await getServerAuthSession();
  if (!session?.user?.id || !isAdminSession(session)) return jsonError('관리자 권한이 필요합니다.', 403);
  if (session.user.isImpersonating) return jsonError('대리 접근 중에는 시민 전용 비서를 만들 수 없습니다.', 403);
  const actor = await actorScopeOr503(session);
  if (actor instanceof Response) return actor;
  if (!actor?.organizationId || !actor.departmentId) return jsonError('소속 기관을 확인할 수 없습니다.', 403);
  if (!actor.managesWholeOrganization) return jsonError('시민 상담 창은 기관 전체 관리자(최상위 부서 소속)만 다룹니다.', 403);

  const { data, error } = await supabaseAdmin
    .from('agents')
    .insert({
      department_id: actor.departmentId,
      tier: 'public',
      visibility: 'organization',
      name: '시민 상담 비서',
      description: '시민용 민원 상담 창(/ask)에서 답하는 비서 — 시민에게 공개해도 되는 문서만 올립니다.',
      icon: '🏛️',
      system_prompt: PUBLIC_AGENT_DEFAULT_PROMPT,
      capabilities: { doc_search: {} },
      is_published: true,
      is_active: true,
      created_by: session.user.id,
      updated_by: session.user.id,
    })
    .select('id, name')
    .single();
  if (error) {
    if (error.code === '23505') return jsonError('시민 전용 비서가 이미 있습니다. 화면을 새로 고쳐 주세요.', 409);
    return jsonError('시민 전용 비서를 만들지 못했습니다. 잠시 뒤 다시 시도해 주세요.', 503);
  }
  // 설정 줄에 비서를 잇는다(설정이 없으면 꺼진 채로 만든다)
  const { error: linkError } = await supabaseAdmin.from('public_ask_settings').upsert(
    { organization_id: actor.organizationId, agent_id: data.id, updated_at: new Date().toISOString(), updated_by: session.user.id },
    { onConflict: 'organization_id' },
  );
  if (linkError) return jsonError('비서는 만들었지만 설정에 잇지 못했습니다. 화면을 새로 고쳐 다시 저장해 주세요.', 503);
  await logSecurityEvent(actor.departmentId, actor.userId, 'public_ask_changed', { agent_created: data.id }, 'high');
  return NextResponse.json({ ok: true, data }, { status: 201 });
}
